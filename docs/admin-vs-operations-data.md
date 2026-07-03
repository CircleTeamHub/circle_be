# Admin vs Operations Data

This document separates the data that belongs in the product admin console from
the data that belongs in the operations/observability stack.

## Current Observability Integrations

The backend and monitoring stack currently include:

- Backend Prometheus metrics at `GET /metrics`.
- Prometheus scraping backend metrics, node-exporter, and cAdvisor every 15s.
- Grafana with the provisioned `circle_be - RED` dashboard.
- Alertmanager routing Prometheus alerts.
- Discord notifications through Alertmanager using `monitoring/alertmanager/discord.url`.
- Uptime Kuma for reachability checks, with optional direct Discord notifications.
- Optional Sentry aggregation for unexpected backend 5xx errors.
- Structured logging for HTTP access, slow requests, security events, rate-limit hits, external-call failures, and business events.

## Admin Console Data

Admin data is for moderators, support, and business operators. It should answer:
"What needs human action?" and "What happened to this user/report/content?"

### MVP Admin Data

- Pending friend/user reports.
- Approved and rejected report history.
- Reporter and target user summaries.
- Report category, description, evidence, created time, review note, reviewer, and review time.
- User list with pagination and account search.
- User status: `ACTIVE`, `BANNED`, `DELETED`.
- User actions: ban, unban, delete/deactivate.
- User profile summary: account ID, nickname, avatar, role, status, credit score, created time, last online.
- OpenIM outbox health summary from `GET /api/v1/outbox/health`.

### Useful Admin Dashboard Cards

- Pending report count.
- Reports submitted today.
- Reports approved/rejected today.
- Total users.
- New users today.
- Banned users.
- Recent login failure trend.
- Rate-limit hit summary for sensitive actions.
- Outbox failed count.

### Admin Data Sources Available Now

- `GET /api/v1/admin/friend-reports`
- `POST /api/v1/admin/friend-reports/:reportId/review`
- `GET /api/v1/user`
- `PATCH /api/v1/user/:id/status`
- `GET /api/v1/auth/me`
- `GET /api/v1/outbox/health`

### Admin Data That Needs Backend Work

- Group report review: `GroupReport` exists, but it has no review status fields
  and no admin review endpoints.
- Global content moderation: moments, plaza posts, notes, circles, and comments
  do not currently have system-admin list/remove/restore endpoints.
- Wallet and coin adjustments: `CoinService.adminTopUp` exists, but there is no
  admin controller endpoint. This should require an audit note and idempotency.
- Admin audit history: moderation actions are logged in application logs, but
  there is no queryable admin-audit table yet.
- Aggregated business/admin stats: Prometheus has counters, but the admin app
  should consume dedicated backend summary endpoints instead of raw PromQL.

## Operations Data

Operations data is for engineering and infrastructure. It should answer:
"Is the system healthy?" and "Where is it failing?"

### Operations Dashboards

Grafana should own:

- Request rate by route.
- 5xx error ratio.
- p95 latency by route.
- Backend process memory.
- Node/process CPU, memory, event-loop, and GC metrics from default Node metrics.
- Host memory from node-exporter.
- Container health/resource metrics from cAdvisor.

Prometheus should own:

- Raw metric storage.
- PromQL queries.
- Target health checks for `circle-be`, `node-exporter`, `cadvisor`, and Prometheus.

Alertmanager should own:

- Alert grouping.
- Alert deduplication.
- Alert routing.
- Discord notifications.

Uptime Kuma should own:

- Reachability monitoring.
- Basic uptime status for backend, Grafana, Prometheus, and other endpoints.
- Direct Discord notifications for uptime failures.

Sentry should own:

- Unexpected 5xx backend exceptions.
- Error grouping.
- Stack traces.
- Request tags such as normalized path, method, request ID, trace ID, and user ID
  when available.

### Current Alert Rules

Defined in `monitoring/prometheus/alerts.yml`:

- `BackendHigh5xx`: backend 5xx ratio greater than 5% for 2 minutes.
- `BackendHighLatencyP95`: backend p95 latency greater than 1s for 5 minutes.
- `TargetDown`: any scrape target down for 2 minutes.
- `HighMemory`: host memory usage greater than 85% for 5 minutes.

### Operations Data That Should Not Be In Admin MVP

- Raw Prometheus queries.
- Full Grafana dashboards embedded in the admin app.
- Sentry stack traces.
- Container-level cAdvisor metrics.
- Host-level node-exporter metrics.
- Alertmanager routing configuration.
- Discord webhook configuration.

The admin app may link to Grafana, Sentry, Alertmanager, and Uptime Kuma, but it
should not become the primary observability UI.

## Boundary Recommendation

Use the admin console for business action queues and user governance:

- Reports.
- Users.
- Moderation decisions.
- Basic health cards that affect support work.

Use the operations stack for system health and incident response:

- Grafana for dashboards.
- Prometheus for metrics and target health.
- Alertmanager and Discord for alert delivery.
- Uptime Kuma for reachability.
- Sentry for backend exception debugging.

For the first admin web version, include only a small system-status section:

- Backend reachable.
- Outbox failed/pending counts.
- Link to Grafana.
- Link to Sentry.
- Link to Uptime Kuma.

Keep deep operational analysis outside the admin console.
