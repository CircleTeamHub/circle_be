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

`/metrics` exposes internal signals (route names, traffic volume, latencies,
memory). **Do not expose it to the public internet.**

It is **not** behind `JwtGuard`: it is mounted as raw Express middleware
(`app.use('/metrics', …)` in `src/setup.ts`), so it never reaches Nest's
controller guards — a scraper cannot hold a JWT anyway. Instead it has an
**opt-in bearer token**:

- Set **`METRICS_AUTH_TOKEN`** and the endpoint requires
  `Authorization: Bearer <token>`, compared in constant time.
- Leave it unset and the endpoint is **open** — the `Authorization` header is
  ignored entirely. In production this logs a startup warning.
- `.env.production.example` ships `METRICS_AUTH_TOKEN=__REPLACE_RANDOM__`, so
  production is expected to run with the token set.

The token is a second layer, not a substitute for network isolation. Also:

- Firewall the path / allowlist Prometheus's IP at the reverse proxy (Caddy), or
- Bind Prometheus and the backend on a private network and only publish the
  API + gateway ports.

> `deploy/gen-env.sh` always writes a random `METRICS_AUTH_TOKEN` into
> `.env.production`, so **production always requires the token** — a scrape job
> that omits it gets a 401 and the target goes DOWN with an empty dashboard.
> `monitoring/docker-compose.prod.yml` wires it up; see
> [Scraping production](../monitoring/README.md#scraping-production).

(This matches the deployment guide: only API, msg-gateway, and MinIO ports are
public; everything else stays internal.)

## What is exposed

| Metric                                                              | Type            | Labels                           | Meaning                                                           |
| ------------------------------------------------------------------- | --------------- | -------------------------------- | ----------------------------------------------------------------- |
| `http_requests_total`                                               | counter         | `method`, `route`, `status_code` | Request count (Rate + Errors)                                     |
| `http_request_duration_seconds`                                     | histogram       | `method`, `route`, `status_code` | Latency (Duration)                                                |
| `business_events_total`                                             | counter         | `event`, `result`                | App-domain events (login, coin gift, …) by name + success/failure |
| `process_*`, `nodejs_*`                                             | gauges/counters | —                                | Default process metrics (CPU, memory, event loop, GC)             |
| `chat_connections_active` / `chat_users_online`                     | gauge           | —                                | Self-hosted chat sockets and distinct users on this instance      |
| `chat_messages_received_total`                                      | counter         | `action`, `result`               | Chat events received by the gateway (send/read/typing/presence)   |
| `chat_message_ack_duration_seconds`                                 | histogram       | `action`                         | Chat handler ACK latency                                          |
| `chat_broadcast_duration_seconds`                                   | histogram       | `action`                         | Time spent handing events to Socket.IO                            |
| `chat_connection_events_total` / `chat_connection_rejections_total` | counter         | `event` / `reason`               | Connection churn and rejected connections                         |
| `circle_cron_runs_total`                                            | counter         | `job`, `result`                  | Scheduled-job runs — catches "running but always failing". `result` is `success` / `failure` / `skipped`; `skipped` is a tick the job's re-entrancy guard turned away and is neither, so it advances no heartbeat and belongs in no failure ratio |
| `circle_cron_last_success_timestamp_seconds`                        | gauge           | `job`                            | Heartbeat — catches "not running at all"; seeded at process start  |
| `circle_cron_interval_seconds`                                      | gauge           | `job`                            | Expected period, so one alert rule fits every job                  |
| `circle_cron_last_duration_seconds`                                 | gauge           | `job`                            | Last run's wall-clock duration                                     |
| `circle_cron_last_result`                                           | gauge           | `job`                            | 1 success / 0 failure — cadence-independent, unlike a rate() window |
| `circle_outbox_pending` / `circle_outbox_oldest_age_seconds`         | gauge           | `queue`                          | Retryable backlog and how long the oldest row has waited           |
| `circle_outbox_dead`                                                 | gauge           | `queue`                          | Rows in a terminal state that will never be retried                |
| `circle_outbox_last_probe_timestamp_seconds`                         | gauge           | `queue`                          | Freshness of that queue's reading — goes stale when its probe keeps failing |
| `circle_db_pool_waiting`                                             | gauge           | —                                | Requests queued for a pg connection — the pool, not Postgres, is the bottleneck |
| `circle_db_pool_total` / `circle_db_pool_idle` / `circle_db_pool_max` | gauge          | —                                | pg pool occupancy against its configured `DATABASE_POOL_MAX`       |

`business_events_total` increments automatically whenever a business event is
logged (`src/logging/business-event.logger.ts`), independent of `BUSINESS_LOG_ON`
— so Grafana can graph business activity without per-event metric code. The
`event` label is the same bounded set as the `business_event` log field.

### Self-hosted chat metrics

`chat_connections_active` and `chat_users_online` are per-backend-instance
gauges. Summing connections across instances is valid; summing users is not a
globally deduplicated online-user count when the same user has sockets on more
than one instance. A future shared-presence implementation should provide the
global user count through Redis or another shared store.

No metric label contains a user ID, conversation ID, or socket ID, so normal
traffic cannot create an unbounded Prometheus series set.

**Routes are normalized** to keep cardinality bounded: dynamic segments (UUIDs,
Mongo ObjectIds, numeric ids) collapse to `:id`, e.g.
`/api/v1/circle/3fa85f64-…` → `/api/v1/circle/:id`. See
`src/metrics/route-normalizer.ts`.

## Prometheus scrape config

Minimal form, for an unauthenticated backend at a fixed address (this is what
local dev uses — `monitoring/prometheus/prometheus.yml`):

```yaml
scrape_configs:
  - job_name: circle-be
    metrics_path: /metrics
    static_configs:
      - targets: ['<backend-host>:3000']
```

**Production needs more than this** and the difference is not optional: the
backend is only reachable on the compose network, requires the bearer token, and
moves between the blue/green containers on every release. That config lives in
`monitoring/prometheus/prometheus.prod.yml` — see
[Scraping production](../monitoring/README.md#scraping-production).

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

# Self-hosted chat — active connections across backend instances
sum(chat_connections_active)

# Self-hosted chat — successful message send QPS
sum(rate(chat_messages_received_total{action="send",result="success"}[1m]))

# Self-hosted chat — send ACK p95
histogram_quantile(
  0.95,
  sum by (le) (
    rate(chat_message_ack_duration_seconds_bucket{action="send"}[5m])
  )
)

# Self-hosted chat — message broadcast p95
histogram_quantile(
  0.95,
  sum by (le) (
    rate(chat_broadcast_duration_seconds_bucket{action="message"}[5m])
  )
)

# Self-hosted chat — rate-limited event rate
sum(rate(chat_messages_received_total{result="rate_limited"}[5m]))
```

## Verifying locally

After restarting the dev server (`npm run start:dev`), make a few requests, then:

```bash
curl -s localhost:3000/metrics | grep http_requests_total
```
