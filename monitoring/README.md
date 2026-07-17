# Monitoring stack (Prometheus + Grafana + Alertmanager)

Observability stack that scrapes the backend `/metrics` (see
[../docs/metrics.md](../docs/metrics.md)), plus host/container metrics, and
visualizes them in Grafana.

- **Local dev** — [Run](#run-local-dev), below. Scrapes `npm run start:dev` on
  your machine.
- **Production** — [Scraping production](#scraping-production). Needs the prod
  overlay; the base file alone monitors nothing on a server.

## Run (local dev)

**Required** — set the Grafana admin password. There is no default, so compose
refuses to start until it is set and a **fresh** volume can never be seeded with
`admin/admin`. On a volume that already exists this value is ignored — see
[the first-boot caveat](#️-grafana_admin_password-only-applies-on-the-first-boot-of-the-volume):

```bash
cp monitoring/.env.example monitoring/.env
# put a real password in GRAFANA_ADMIN_PASSWORD (openssl rand -base64 24)
```

Optional — if you want Alertmanager to send Discord notifications, create the
gitignored webhook file before starting the stack:

```bash
cp monitoring/alertmanager/discord.url.example monitoring/alertmanager/discord.url
# then paste your real Discord webhook URL into discord.url
```

```bash
docker compose -f monitoring/docker-compose.yml up -d
```

| UI           | URL                   | Login                        |
| ------------ | --------------------- | ---------------------------- |
| Grafana      | http://localhost:3001 | from `monitoring/.env`       |
| Prometheus   | http://localhost:9090 | —                            |
| Alertmanager | http://localhost:9093 | —                            |
| Uptime-Kuma  | http://localhost:3002 | set on first visit           |

In Grafana the **Prometheus** datasource and the **circle_be — RED** dashboard
are auto-provisioned (Dashboards → circle_be — RED).

### ⚠️ `GRAFANA_ADMIN_PASSWORD` only applies on the FIRST boot of the volume

Grafana seeds the admin user into the `grafana_data` volume once, on first boot.
After that `GRAFANA_ADMIN_PASSWORD` is **silently ignored** — the container logs
`Config overridden from Environment variable: GF_SECURITY_ADMIN_PASSWORD` on
every start, which reads like it applied, but it did not.

Verified against `grafana/grafana:13.1.0` on an existing volume:

| Login attempt after changing the env var and recreating | Result |
| --- | --- |
| the **new** `GRAFANA_ADMIN_PASSWORD` | **401** — never applied |
| the password the volume was **originally** seeded with | **200** — still live |

So **if your `grafana_data` volume predates this password being set, changing it
buys you nothing** — the old credential still works and the new one does not.
Check when your volume was created:

```bash
docker volume inspect monitoring_grafana_data --format '{{.CreatedAt}}'
```

**To actually change it, reset in place** — no volume deletion, no data loss:

```bash
# note: `grafana cli`, NOT `grafana-cli` — the legacy binary no longer exists
# in the Grafana image, and the old `grafana-cli ...` snippet fails there.
docker compose -f monitoring/docker-compose.yml exec grafana \
  grafana cli --homepath /usr/share/grafana admin reset-admin-password 'NEW_PASSWORD'
```

It takes effect immediately, with no restart. Then put the same value in
`monitoring/.env` so the two agree (it still will not be what seeds the volume —
it just keeps compose from refusing to start).

> **Do not use `down -v` as the reset path.** It wipes every volume in the
> stack, not just Grafana's: you also lose all your **Uptime-Kuma monitors and
> notification setup** and your **Prometheus history**. Reset in place instead.

Stop / wipe:

```bash
docker compose -f monitoring/docker-compose.yml down       # keep data
docker compose -f monitoring/docker-compose.yml down -v    # wipe volumes — this
                                                           # also destroys your
                                                           # Uptime-Kuma monitors
                                                           # and Prometheus history
```

## ⚠️ Restart the backend first (dev)

In dev the `circle-be` scrape target points at `host.docker.internal:3000`. If
your backend is still running the old build it has no `/metrics`, so the target
shows **DOWN**. Restart it on the new code:

```bash
npm run start:dev
```

Then check **Prometheus → Status → Targets** — `circle-be` should be **UP**.

## Scraping production

Everything above runs the stack against the **dev** backend on your machine. A
plain `docker compose -f monitoring/docker-compose.yml up -d` on a production
box monitors **nothing**: the `circle-be` job points at `host.docker.internal:3000`,
but production only does `expose: 3000` on the compose network and never
publishes the port. Prometheus dials a port that isn't there, the target is
DOWN, and the dashboard is empty while looking installed.

Add the **prod overlay** to fix that:

```bash
docker compose -f monitoring/docker-compose.yml \
               -f monitoring/docker-compose.prod.yml up -d
```

The overlay joins Prometheus to the `circle-be` compose network, swaps in
[`prometheus/prometheus.prod.yml`](prometheus/prometheus.prod.yml)
(blue-green DNS discovery + bearer auth) and mounts the token file. The base
file alone is unchanged, so local dev keeps working exactly as before.

### Turning it on — step by step

Run these on the server, from the repo root, **after** the app stack is up.

1. **Confirm the app stack is running** — the overlay attaches to a network the
   `circle-be` project owns, and will not create it:

   ```bash
   docker network inspect circle-be_default --format '{{.Name}}'
   ```

   Nothing? Bring the app stack up first (DEPLOY.md §4). If you run it under a
   different compose project name, set `CIRCLE_BE_NETWORK` in `monitoring/.env`.

2. **Publish the metrics token to Prometheus.** `deploy/gen-env.sh` always puts a
   random `METRICS_AUTH_TOKEN` in `.env.production`, so a correctly bootstrapped
   backend **always** requires a bearer token — scraping it without one is a
   guaranteed `401`, not an edge case:

   ```bash
   bash monitoring/sync-metrics-token.sh
   ```

   This writes the gitignored `monitoring/prometheus/metrics_token`. Prometheus
   runs as uid `65534`, so if the script tells you to, run the `chown` it prints —
   a file it cannot read produces a `401`, i.e. the same symptom as a wrong token.

3. **Set the Grafana password** (see the first-boot caveat above):

   ```bash
   cp monitoring/.env.example monitoring/.env   # then fill GRAFANA_ADMIN_PASSWORD
   ```

4. **Start it:**

   ```bash
   docker compose -f monitoring/docker-compose.yml \
                  -f monitoring/docker-compose.prod.yml up -d
   ```

5. **Verify — do not skip this.** The whole failure mode here is monitoring that
   looks installed and reports nothing:

   ```bash
   docker compose -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml \
     exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=up{job="circle-be"}'
   ```

   You want `"value":[…,"1"]` with `"instance":"circle-be-blue"` (or `-green`).
   `"0"` means it is reachable but rejecting you — check `lastError` on
   **Status → Targets**; `401 Unauthorized` means step 2 is wrong or stale. An
   empty `result` means no backend container exists at all.

### After rotating `METRICS_AUTH_TOKEN`

Re-run step 2 and reload, or every scrape 401s:

```bash
bash monitoring/sync-metrics-token.sh
docker compose -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml \
  restart prometheus
```

### How the blue-green target works

Deployment alternates the live container between `circle-be-blue` and
`circle-be-green`, and `deploy/release-deploy.sh` **removes** the retired colour —
so in steady state exactly one of the two names exists. A static target pinned to
one colour is DOWN after every other release; two static targets leave one
permanently red, which just teaches you to ignore red.

So the job resolves **both container names via Docker's embedded DNS** and takes
whatever exists:

| Situation | Targets |
| --- | --- |
| Steady state | 1 — the live colour. The absent name is NXDOMAIN and contributes nothing (no error, no lookup failure). |
| Mid-release | 2 — both colours, with distinct `instance` labels. You can watch the new colour before Caddy switches to it. |
| After the switch | 1 — the removed colour's series goes stale within ~30s, well inside `TargetDown`'s `for: 2m`, so a release does not page you. |
| No backend at all | 0 — **`up` stops existing rather than going to 0**, so `up == 0` cannot fire. The `CircleBeNoTarget` `absent()` rule in `alerts.yml` covers exactly this. Do not delete it. |

`instance` is relabelled from the resolved name to a stable `circle-be-blue` /
`circle-be-green` (otherwise it would be the container IP, which changes on every
release), and a `color` label is added so you can tell them apart mid-release.

> **Caveat:** this relies on Docker's embedded DNS being authoritative for
> container names, which it is for any user-defined network. If your host's
> resolver hijacks NXDOMAIN (some ISP resolvers do), the absent colour could
> resolve to a bogus public IP and show as a DOWN target rather than no target.
> That fails loudly, not silently — but if you see it, switch the job to
> `docker_sd_config`, which needs no DNS but does need the Docker socket mounted
> into Prometheus (a root-equivalent privilege — that is why DNS is the default).

## Notes / caveats

- **Grafana is on host port 3001** (the backend owns 3000).
- **Management UIs bind to `127.0.0.1` only** (Grafana `3001`,
  Prometheus `9090`, Alertmanager `9093`, Uptime-Kuma `3002`). Use an SSH tunnel
  or an authenticated reverse proxy for remote access.
- **`host.docker.internal`** lets the containers reach the backend on the host;
  it works on Docker Desktop and (via `extra_hosts: host-gateway`) on Linux.
- **macOS:** `node-exporter` measures the Docker Desktop **Linux VM**, not macOS
  itself. On a real Linux server it measures the host. `cAdvisor` can be flaky on
  Docker Desktop for Mac — if it crash-loops, comment out the `cadvisor` service
  and its scrape job; the rest is unaffected.
- **OpenIM metrics:** a commented scrape job is in `prometheus/prometheus.yml`;
  enable it once you confirm OpenIM's metrics port for your version.

## Relationship to OpenIM's own monitoring stack

`DEPLOY.md` has the operator clone
[openim-docker](https://github.com/openimsdk/openim-docker) separately, and that
compose file **also ships prometheus / alertmanager / grafana / node-exporter**.
Two things stop it colliding with this stack — both are upstream defaults, not
local tweaks:

- **It is opt-in.** All four services sit behind `profiles: [m]`, so a plain
  `docker compose up -d` in openim-docker starts **no** monitoring at all. You
  only get them with `--profile m`.
- **Its ports are renumbered into the 1xxxx range** and it uses
  `network_mode: host` (no published ports):

  | Service       | OpenIM (`--profile m`) | This stack |
  | ------------- | ---------------------- | ---------- |
  | Prometheus    | 19090                  | 9090       |
  | Alertmanager  | 19093                  | 9093       |
  | Grafana       | 13000                  | 3001       |
  | node-exporter | 19100                  | (internal) |

So both can run on one box. If you do run both with `--profile m`, you get two
node-exporters measuring the same host — harmless, just redundant.

**We deliberately do not add a `circle-be` job to OpenIM's Prometheus.** Its
config lives in the upstream checkout (`config/prometheus.yml`), so any edit is
lost on the operator's next `git pull`; replacing it via an override would mean
vendoring OpenIM's whole service-discovery config into this repo and keeping it
in sync with their releases. Its Grafana also runs
`GF_AUTH_ANONYMOUS_ENABLED=true` with `GF_AUTH_ANONYMOUS_ORG_ROLE=Admin` —
anyone who reaches the port is an admin — which is a worse home for our
dashboards than the password-protected Grafana here.

## Alerts → Discord

Alertmanager has a native Discord receiver (no converter needed). The webhook
URL is read from a **gitignored** `alertmanager/discord.url`. Alertmanager still
starts if the file is missing, but Discord notifications fail until the file is
created.

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

1. Open **http://localhost:3002**, create the admin account immediately on first
   visit. The compose file binds this UI to `127.0.0.1` so the first-run setup is
   not exposed to the LAN.
2. **Add New Monitor** for each thing to watch, e.g.:
   - Backend — `http://host.docker.internal:3000/metrics` (HTTP, accept 200)
   - Grafana — `http://grafana:3000` · Prometheus — `http://prometheus:9090/-/healthy`
   - OpenIM / your public API URL
3. **Settings → Notifications → Setup Notification → Discord**, paste the same
   webhook URL → assign it to the monitors. Uptime-Kuma pings Discord directly
   (no Alertmanager involved).

## Production

- Pin image versions (these are `:latest` for a quick local start) before using
  this stack outside local development.
- Keep `/metrics`, Prometheus, Grafana, Alertmanager, and Uptime-Kuma on an
  internal network — do not expose them publicly (see the security note in
  `../docs/metrics.md`).
- Supply `GRAFANA_ADMIN_PASSWORD` from a secret manager rather than a
  `monitoring/.env` file on the box.
- **The base compose file targets the dev backend.** Scraping production needs
  the prod overlay — see [Scraping production](#scraping-production). Bringing
  this stack up on a server *without* the overlay monitors nothing.
- **Never point the `circle-be` job at a public URL.** `deploy/Caddyfile.admin`
  returns 404 for `/metrics` on purpose; the scrape path is the internal compose
  network, and the bearer token is a second layer behind that, not a substitute
  for it.
- Use VPN, SSH tunneling, or an authenticated reverse proxy for remote access to
  monitoring UIs; do not publish the compose ports directly.
- Provide `alertmanager/discord.url` through a secret manager or secure runtime
  mount instead of copying a webhook file onto the server manually.
- Keep Uptime-Kuma behind a private network or reverse proxy with authentication;
  do not expose the first-run setup publicly.
