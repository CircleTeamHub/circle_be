# Metrics (Prometheus)

The backend exposes Prometheus metrics for scraping. This is the "runtime state"
line of observability (Rate / Errors / Duration), complementary to error
aggregation via Sentry (see [logging.md](./logging.md)).

## Endpoint

- **`GET /metrics`** — Prometheus exposition format (`text/plain`).
- Served as raw Express middleware, so it is **not** under the `api/v1` prefix
  and is **not** wrapped by the JSON response interceptor. The scrape target is
  `http://<host>:<APP_PORT>/metrics` (default port `3000`).
- It is exempt from the global rate limiter, and it does not record a metric for
  itself.

## ⚠️ Security: keep it internal

`/metrics` is **unauthenticated** and exposes internal signals (route names,
traffic volume, latencies, memory). **Do not expose it to the public internet.**
In production, restrict it so only Prometheus can reach it:

- Firewall the path / allowlist Prometheus's IP at the reverse proxy (Nginx), or
- Bind Prometheus and the backend on a private network and only publish the
  API + gateway ports.

(This matches the deployment guide: only API, msg-gateway, and MinIO ports are
public; everything else stays internal.)

## What is exposed

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status_code` | Request count (Rate + Errors) |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Latency (Duration) |
| `business_events_total` | counter | `event`, `result` | App-domain events (login, coin gift, …) by name + success/failure |
| `process_*`, `nodejs_*` | gauges/counters | — | Default process metrics (CPU, memory, event loop, GC) |

`business_events_total` increments automatically whenever a business event is
logged (`src/logging/business-event.logger.ts`), independent of `BUSINESS_LOG_ON`
— so Grafana can graph business activity without per-event metric code. The
`event` label is the same bounded set as the `business_event` log field.

**Routes are normalized** to keep cardinality bounded: dynamic segments (UUIDs,
Mongo ObjectIds, numeric ids) collapse to `:id`, e.g.
`/api/v1/circle/3fa85f64-…` → `/api/v1/circle/:id`. See
`src/metrics/route-normalizer.ts`.

## Prometheus scrape config

```yaml
scrape_configs:
  - job_name: circle-be
    metrics_path: /metrics
    static_configs:
      - targets: ["<backend-host>:3000"]
```

## Example queries (RED method)

```promql
# Rate — requests/sec per route
sum by (route) (rate(http_requests_total[1m]))

# Errors — 5xx error ratio
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))

# Duration — p95 latency per route
histogram_quantile(
  0.95,
  sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))
)

# Business — events/min by name (e.g. logins, coin gifts)
sum by (event) (rate(business_events_total[1m])) * 60

# Business — success ratio for a given event
sum(rate(business_events_total{event="auth_login",result="success"}[5m]))
  / sum(rate(business_events_total{event="auth_login"}[5m]))
```

## Verifying locally

After restarting the dev server (`npm run start:dev`), make a few requests, then:

```bash
curl -s localhost:3000/metrics | grep http_requests_total
```
