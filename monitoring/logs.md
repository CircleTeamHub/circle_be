# Optional centralized application logs

This adds local Loki + Grafana Alloy to the existing monitoring stack. It uses
the backend's redacted JSON rolling files, which mirror application stdout,
without granting a collector access to Docker's socket or host log directory.
It also collects the sanitized copy Caddy writes itself to the `caddy_logs`
volume (`log collected` in `deploy/Caddyfile.admin`): runtime and upstream proxy
errors, TLS issuance/renewal and `/chat-ws` handshakes, with the whole request
URI (share-link, temp-chat and QR tokens sit in the path, not just the query),
all request headers, IPs and ports removed before encoding. To see which route
failed, use the backend's own lines, which carry the route template and
`requestId`. The same streams also go to Caddy's stdout, sanitized the same way
(`log collected_stdout`): a named Caddyfile logger removes its namespaces from
the default log, so without that twin `docker compose logs caddy` would lose
them. Site-wide access logs stay off.

It does not collect database logs, native stderr, or output before the
application logger starts. `docker compose logs` remains useful for those.
Database logs are left out on purpose: PostgreSQL cannot write to stderr and a
file at once, so collecting them means moving its output off `docker compose
logs`, restarting the database, and a log directory whose wrong ownership stops
it from starting; error `DETAIL` lines also carry row values. postgres-exporter
(`PostgresDown`, connection and lock alerts) and the backend's slow-query events
cover availability and performance instead.

Blue and green each write a separate `/app/logs` named volume; Alloy reads both
read-only. Container replacement preserves files and cannot make the colors
rotate one another's files. Only `application-*.log*` is collected, avoiding
duplicates from the error-only transport. Application files rotate hourly or at
20 MB, remain uncompressed for catch-up, and expire after 14 days while that
color's file transport runs. An inactive color's old files are cleaned on its
next start. This is a retention policy, **not a disk-size ceiling**.

Loki keeps seven days of searchable logs on the local filesystem. Its WAL,
index, chunks and compactor deletion markers persist in `loki_data`; Alloy's
offsets and sender WAL persist in `alloy_data`. Chunk deletion is asynchronous
and has a two-hour delay. This single-host setup shares the host's failure
domain with the application; it is not an audit archive or disaster backup.

## Enable on an approved deployment

Commands below are Linux server operator steps, from the repository root.
Do not point a test deployment at production volumes.

1. Deploy the backend revision containing the JSON logger and log-volume mounts
   through the normal blue-green release process. Set `LOG_ON=true` and
   `LOG_FILE_ON=true` in `.env.production`, with `LOG_LEVEL=info`. Production
   output is always JSON. `LOG_ON` is the master logging gate; use
   `HTTP_LOG_ON=false` to disable request logs while retaining file collection.
   Existing containers gain the mount only when recreated. Old logs inside
   previous container writable layers are not migrated.
2. Prepare both color volumes before starting Alloy, including the inactive
   color. Set `CIRCLE_BE_IMAGE` to the **same approved immutable image** used by
   that release. These one-off commands only check file permissions; they do
   not start the application, run migrations, or restart a live container:

   ```bash
   for service in circle_be circle_be_green; do
     docker compose -f docker-compose.prod.yml -f docker-compose.release.yml \
       run --rm --no-deps --entrypoint node "$service" -e '
         const fs = require("fs");
         const p = "/app/logs/.collector-permission-check";
         fs.writeFileSync(p, "", { mode: 0o644 });
         fs.unlinkSync(p);
         console.log("log volume writable by uid", process.getuid());
       '
   done
   ```

   Docker initializes a fresh volume from the image's `/app/logs` directory,
   owned by the existing non-root `app` user. Do not pre-create a root-owned
   `/app/logs` directory or use `volume.nocopy`. The collector runs as uid 473
   and reads the logger's 0644 files through the directory's 0755 permissions.
   With a custom app project, include the same `-p PROJECT` in these commands.
3. Complete the existing [production monitoring setup](README.md#scraping-production).
   In `monitoring/.env`, set `LOG_ENVIRONMENT=production` (one fixed value per
   environment) and, if the app uses a custom Compose project name,
   `CIRCLE_BE_PROJECT_NAME=PROJECT`. This must match the app's actual project,
   not the monitoring project's name. Defaults are `circle-be_app_logs_blue`,
   `circle-be_app_logs_green` and `circle-be_caddy_logs`. Inspect them with
   `docker volume inspect` before enabling collection; Alloy deliberately fails
   if they do not exist. `caddy_logs` only appears once Caddy has been recreated
   from this revision's Compose file — releases never recreate Caddy, so do it
   once by hand (`docker compose -f docker-compose.prod.yml up -d --no-deps caddy`,
   after rebuilding its image if `Dockerfile.caddy` changed).
4. Validate and enable the overlay. Prometheus must be included so Compose adds
   the private network and collector target mount to its existing container:

   ```bash
   docker compose --env-file monitoring/.env \
     -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml \
     -f monitoring/docker-compose.logs.yml config --quiet

   docker compose --env-file monitoring/.env \
     -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml \
     -f monitoring/docker-compose.logs.yml up -d --no-deps loki alloy grafana prometheus alertmanager
   ```

   Alertmanager must be in that list too: the overlay adds it to the internal
   `logs` network, and Loki's ruler can reach it only there. Leave it out and
   the log alerts below are never delivered (`LokiRulerNotificationsFailing`
   fires). Confirm Prometheus lists healthy `component="loki"` and
   `component="alloy"` targets under the `logs-pipeline` job before treating
   collection as enabled.

The overlay publishes no Loki/Alloy ports. Only Grafana, Prometheus and
Alertmanager join their internal Docker network. Loki has no authentication of its own; never expose
its API through Caddy or a public port without an authenticated gateway. Grafana
stays on its existing loopback port and uses its existing login. Use the SSH
tunnel described in the monitoring README. The datasource template is mounted
as YAML only by this overlay, so metrics-only installs do not enable it.

## Log alerts

Loki's ruler evaluates `monitoring/loki/rules/fake/*.yml` every minute (the
single-tenant mode's tenant is literally `fake`) and sends alerts to the same
Alertmanager as Prometheus, so they follow the same severity routing and
inhibition (`CircleBeNoTarget` and `PostgresDown` suppress
`BackendErrorLogSpike`; `CaddyProxyErrors` stays on during a backend outage
because it also covers the MinIO and admin_web upstreams). The spike alerts' `for` is longer than their window on purpose: a
single burst, such as a blue/green switch, leaves the window before `for` is
met, so only sustained errors fire. The overlay joins Alertmanager to the internal `logs` network
rather than exposing Loki. Current rules:

| Alert | Fires when |
|---|---|
| `BackendFatalExit` | a `[fatal] Uncaught exception` line (from `application-fatal.log`) in the last 10m |
| `BackendErrorLogSpike` | more than 50 backend error-level lines per 5m, sustained for 10m |
| `CaddyProxyErrors` | more than 10 error-level Caddy proxy/handler lines per 5m, sustained for 10m |
| `CaddyCertificateErrors` | any Caddy TLS error in the last 30m — renewal is failing well before `TlsCertificateExpiringSoon` |
| `SecurityCodeGuessing` | more than 20 wrong security / login-challenge codes per 5m, sustained for 10m |
| `SecurityCodeLockouts` | 3 or more security-code lockouts in 30m (each is 5 wrong codes on one account) |
| `RevokedSessionTokenReplay` | one revoked session used 20+ times in 15m, or revoked sessions of 5+ users replayed (a normal logout-all of several devices does neither) |
| `InvalidTokenSpike` | more than 50 forged / mis-signed tokens per 5m, sustained for 10m (a key rotation recovers on the next refresh and does not last that long) |

The security rules read the `security_event` lines described in
[docs/logging.md](../docs/logging.md#security-event-catalogue); they need
`SECURITY_LOG_ON` (on by default outside tests).

After enabling the overlay, `curl -s loki:3100/loki/api/v1/rules` from a
container on the `logs` network lists the loaded rules.

## Check ingestion and investigate an incident

Use Grafana Explore → **Loki**. Trigger one ordinary backend request, wait a few
seconds, and choose the last 15 minutes. If HTTP logs are disabled, use a known
safe business event instead. Check both colors after the next routine release.

```logql
{service="circle-be", environment="production"}
{service="circle-be", environment="production", level=~"error|warn"}
{service="circle-be", environment="production"} | json | requestId="REQUEST_ID"
{service="circle-be", environment="production"} | json | job="JOB_NAME"
```

`service`, `environment`, and normalized `level` are the only index labels.
Request/trace/job identifiers remain JSON fields and are filtered at query
time. Do not add users, paths, IDs, release SHAs, or filenames as labels.
Replace the example field/value with the event's actual JSON field when needed.

For empty results, inspect `docker compose` **with all three monitoring files**
using `logs --tail 100 alloy loki`; check volume names, the active app's mount,
`LOG_ON`/`LOG_FILE_ON`, filesystem permissions, time range, and `LOG_ENVIRONMENT`.
Alloy rejects malformed JSON. Loki rejects oversized, too-old, or substantially
out-of-order entries; an old-file replay can therefore be partial. Preserve
source files for manual inspection. Healthy processes alone do not prove that
delivery works: verify a fresh event is queryable, and investigate Alloy's
`loki_write_dropped_entries_total` or retry errors if delivery stalls.

The optional overlay mounts Loki and Alloy targets into Prometheus and joins
Prometheus to the private `logs` network; neither service publishes a host
port. `TargetDown` covers a stopped target and `LogPipelineDroppedEntries`
reports permanent Alloy drops. Metrics-only deployments have no log-pipeline
targets, so an intentionally absent optional stack does not alert.

## Retention, recovery and rollback

Monitor disk usage with the existing host-disk alerts; reserve space for both
14-day source files and seven-day Loki data, plus indexes/WAL and deletion delay.
Size the host using observed daily ingestion before enabling this on a small
database host. Memory limits are 512 MB for Loki and 256 MB for Alloy; check for
OOM/restarts under real load and adjust deliberately.

Alloy's sender WAL is **experimental in v1.19.2**, hence the explicit stability
flag. It retains segments for one hour and retries batches for a bounded time;
WAL, source-file offsets, retention, network errors and abrupt termination do
not provide exactly-once or lossless delivery. Keep source files and offset
storage intact during recovery. Reading retained files after deleting offsets
can duplicate records; replaying old data into an already active stream can
also be rejected by Loki. Do not delete offsets as routine troubleshooting.

To pause collection, use the full Compose file set and `stop alloy`; to pause
the entire log service, `stop alloy loki`. Application logging continues.
To remove the overlay, stop Alloy/Loki with all three files, then reconcile the
two changed base services without the overlay:

```bash
docker compose --env-file monitoring/.env -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml \
  -f monitoring/docker-compose.logs.yml stop alloy loki
docker compose --env-file monitoring/.env -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml \
  up -d --no-deps --force-recreate prometheus grafana
```

Recreating Prometheus removes the collector targets/network; recreating Grafana
removes the Loki datasource through provisioning's `prune: true`.
Preserve all named volumes.
Do not use `down -v`: it also destroys other monitoring history. Re-enable using
the same overlay and volume names to resume from saved positions.

During the JSON-log migration window, malformed or unknown-level rollback lines
are replaced wholesale with `legacy rollback log content redacted by collector`
and `level="unknown"`. This preserves safe timing/count visibility without
copying pre-sanitizer prose, user IDs, object keys, or exception messages into
Loki. Restricted source volumes remain available for incident handling.

## Validate changes without starting the stack

```bash
npm test -- --runInBand src/logging/centralized-logging-config.spec.ts
docker run --rm --network none --read-only \
  -v "$PWD/monitoring/loki/config.yml:/etc/loki/config.yml:ro" \
  grafana/loki:3.7.0 -config.file=/etc/loki/config.yml -verify-config=true
docker run --rm --network none --read-only --user 473:473 \
  -e LOG_ENVIRONMENT=test \
  -v "$PWD/monitoring/alloy/config.alloy:/etc/alloy/config.alloy:ro" \
  grafana/alloy:v1.19.2 validate --stability.level=experimental /etc/alloy/config.alloy
```

Pinned versions and config follow the official [Loki Docker installation](https://grafana.com/docs/loki/latest/setup/install/docker/),
[retention](https://grafana.com/docs/loki/latest/operations/storage/retention/),
[Alloy file collection](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.file/),
and [sender WAL](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/) references.
Review the [Alloy v1.19.2 release](https://github.com/grafana/alloy/releases/tag/v1.19.2)
and validate both binaries before updating pins.
