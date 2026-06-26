# Monitoring stack (Prometheus + Grafana + Alertmanager)

Local observability stack that scrapes the backend `/metrics` (see
[../docs/metrics.md](../docs/metrics.md)), plus host/container metrics, and
visualizes them in Grafana.

## Run

```bash
docker compose -f monitoring/docker-compose.yml up -d
```

| UI | URL | Login |
|---|---|---|
| Grafana | http://localhost:3001 | admin / admin |
| Prometheus | http://localhost:9090 | — |
| Alertmanager | http://localhost:9093 | — |
| Uptime-Kuma | http://localhost:3002 | set on first visit |

In Grafana the **Prometheus** datasource and the **circle_be — RED** dashboard
are auto-provisioned (Dashboards → circle_be — RED).

Stop / wipe:

```bash
docker compose -f monitoring/docker-compose.yml down       # keep data
docker compose -f monitoring/docker-compose.yml down -v    # wipe volumes
```

## ⚠️ Restart the backend first

The `circle-be` scrape target points at `host.docker.internal:3000`. If your
backend is still running the old build it has no `/metrics`, so the target shows
**DOWN**. Restart it on the new code:

```bash
npm run start:dev
```

Then check **Prometheus → Status → Targets** — `circle-be` should be **UP**.

## Notes / caveats

- **Grafana is on host port 3001** (the backend owns 3000).
- **`host.docker.internal`** lets the containers reach the backend on the host;
  it works on Docker Desktop and (via `extra_hosts: host-gateway`) on Linux.
- **macOS:** `node-exporter` measures the Docker Desktop **Linux VM**, not macOS
  itself. On a real Linux server it measures the host. `cAdvisor` can be flaky on
  Docker Desktop for Mac — if it crash-loops, comment out the `cadvisor` service
  and its scrape job; the rest is unaffected.
- **OpenIM metrics:** a commented scrape job is in `prometheus/prometheus.yml`;
  enable it once you confirm OpenIM's metrics port for your version.

## Alerts → Discord

Alertmanager has a native Discord receiver (no converter needed). The webhook
URL is read from a **gitignored** `alertmanager/discord.url`.

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**, pick
   a channel, **Copy Webhook URL**.
2. Put it in the file (one line, no quotes):
   ```bash
   cp monitoring/alertmanager/discord.url.example monitoring/alertmanager/discord.url
   # then paste your webhook URL into discord.url
   ```
3. Reload Alertmanager:
   ```bash
   docker compose -f monitoring/docker-compose.yml restart alertmanager
   ```

Test it fires by posting a throwaway alert to Alertmanager's API:
```bash
curl -XPOST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"DiscordTest","severity":"critical"}}]'
```

## Uptime monitoring (Uptime-Kuma)

Covers the gap Prometheus can't: **"is the service even reachable?"** Configured
in its own UI (data persists in a volume).

1. Open **http://localhost:3002**, create the admin account (first visit).
2. **Add New Monitor** for each thing to watch, e.g.:
   - Backend — `http://host.docker.internal:3000/metrics` (HTTP, accept 200)
   - Grafana — `http://grafana:3000` · Prometheus — `http://prometheus:9090/-/healthy`
   - OpenIM / your public API URL
3. **Settings → Notifications → Setup Notification → Discord**, paste the same
   webhook URL → assign it to the monitors. Uptime-Kuma pings Discord directly
   (no Alertmanager involved).

## Production

- Pin image versions (these are `:latest` for a quick local start).
- Keep `/metrics`, Prometheus, and Grafana on an internal network — do not expose
  them publicly (see the security note in `../docs/metrics.md`).
- Change the Grafana admin password.
