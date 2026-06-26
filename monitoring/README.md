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
- **Alerts → 飞书:** `alertmanager/alertmanager.yml` has a no-op receiver plus
  instructions. Alertmanager's JSON differs from Feishu's card format, so route
  through a small converter (the backend `ops-alert` pattern) rather than the raw
  Feishu webhook.

## Production

- Pin image versions (these are `:latest` for a quick local start).
- Keep `/metrics`, Prometheus, and Grafana on an internal network — do not expose
  them publicly (see the security note in `../docs/metrics.md`).
- Change the Grafana admin password.
