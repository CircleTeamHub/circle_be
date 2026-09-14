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
- blackbox_exporter probing the public entry points (production overlay), alerting through Alertmanager like every other alert.
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
- `GET /api/v1/admin/users`（脱敏列表；原先明文返回联系方式、不经隐私开关的
  `GET /api/v1/user` / `POST /api/v1/user` 已移除）
- `PATCH /api/v1/admin/users/:id/status`（唯一的状态变更入口，带审计留痕；
  原先无审计的 `PATCH /api/v1/user/:id/status` 已随 #121 移除）
- `GET /api/v1/auth/me`
- `GET /api/v1/outbox/health`

### Admin Routes Without Admin-Console UI

These routes exist behind `JwtGuard + AdminGuard`, but `circle_admin_web` has no
page that calls them yet. Operate them with curl / ops scripts and an admin
access token.

- `GET /api/v1/admin/moderation/group-reports`, `GET /api/v1/admin/moderation/post-reports`: list group / circle-post reports (`status` defaults to `PENDING`, `page` ≤ 500, `limit` ≤ 100); no admin-console UI yet (curl / ops).
- `POST /api/v1/admin/moderation/group-reports/:reportId/review`, `POST /api/v1/admin/moderation/post-reports/:reportId/review`: approve or reject a pending report (`{ approve, note? }`, `note` ≤ 500); the PENDING → final transition is claimed atomically and a second review gets 409; no admin-console UI yet (curl / ops).
- `POST /api/v1/admin/moderation/posts/:postId/takedown`: take a circle post down (→ `DELETED`, optional `note` ≤ 500, audited in the same transaction); calling it on an already deleted post returns the current status; no admin-console UI yet (curl / ops).
- `POST /api/v1/admin/moderation/posts/:postId/restore`: restore a moderation takedown (→ `ENDED`, not `ACTIVE`); refuses posts deleted by their own author (409), and a post that is not deleted is returned unchanged; no admin-console UI yet (curl / ops).
- `GET /api/v1/admin/sensitive-words`, `POST /api/v1/admin/sensitive-words/add`, `POST /api/v1/admin/sensitive-words/remove`: list / bulk-add / bulk-remove chat sensitive words (`words`: 1–1000 items, each ≤ 64 chars; add and remove are audited); no admin-console UI yet (curl / ops).
- `POST /api/v1/admin/system-announcements`: publish a system announcement to active users (`content` 1–5000); requires the `Idempotency-Key` header (≤ 128 chars, reuse it when retrying) and is throttled to 2 requests/min per admin; no admin-console UI yet (curl / ops).
- `POST /api/v1/admin/memberships/users/:userId/grants`: audited membership activation / upgrade (`targetLevel` 1–4, `note` ≤ 500); idempotent through the body field `idempotencyKey` (UUID, not a header); no admin-console UI yet (curl / ops).
- `POST /api/v1/admin/memberships/program/enable`: permanently enable membership enforcement; replay-safe (a repeated call returns `replayed: true` with the existing status); no admin-console UI yet (curl / ops).
- `GET /api/v1/admin/mall/fancy-numbers`: list the fancy-number inventory; no admin-console UI yet (curl / ops; the console only manages `/recommendations`).
- `POST /api/v1/admin/mall/fancy-numbers/batch`: add 1–100 available fancy numbers (trimmed, lower-cased, deduplicated); not idempotent — the whole batch is rejected with 409 if any value is already taken, including by an earlier attempt; no admin-console UI yet (curl / ops).
- `PATCH /api/v1/admin/mall/fancy-numbers/:id/status`: enable or disable an available fancy number (`{ enabled }`); no admin-console UI yet (curl / ops).
- `GET /api/v1/admin/support/agents/audit-logs`: history of whole-table support-agent configuration writes (`limit`, default 20); no admin-console UI yet (curl / ops).

### Admin Data That Needs Backend Work

- Group / plaza-post report review and post takedown: the backend routes exist
  (`/api/v1/admin/moderation/*`, listed above), but the admin console has no page
  for them yet.
- Global content moderation: moments, notes, and comments still have no
  system-admin list/remove/restore endpoints. Plaza posts can be taken down and
  restored under `/api/v1/admin/moderation/posts/:postId/*`; circles can be
  disabled and restored under `/api/v1/admin/community/circles/:id/*`.
- Wallet and coin adjustments: there is no free-form admin top-up
  (`CoinService.adminTopUp` no longer exists). Coins are only credited by approving
  a support recharge order (`POST /api/v1/admin/support/recharge/orders/:id/approve`),
  which goes through `CoinService.creditInTransaction` with the order id as the
  idempotency key and writes an admin audit entry. A manual adjustment endpoint
  would still need its own audit note and idempotency key.
- Admin audit history: moderation, sensitive-word, community and avatar-frame
  actions are written to the `AdminAuditLog` table, but it can only be read per
  target (`GET /api/v1/admin/users/:id/audit-logs`,
  `GET /api/v1/admin/support/agents/audit-logs`); there is no global audit
  browser yet.
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
- Public reachability and TLS certificate expiry, probed by blackbox_exporter
  along the same DNS/TLS/Caddy path users take.

Alertmanager should own:

- Alert grouping.
- Alert deduplication.
- Alert routing.
- Discord notifications.

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
- `PublicEndpointDown`: a public entry point failing its probe for 2 minutes.

### Operations Data That Should Not Be In Admin MVP

- Raw Prometheus queries.
- Full Grafana dashboards embedded in the admin app.
- Sentry stack traces.
- Container-level cAdvisor metrics.
- Host-level node-exporter metrics.
- Alertmanager routing configuration.
- Discord webhook configuration.

The admin app may link to Grafana, Sentry, and Alertmanager, but it should not
become the primary observability UI.

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
- blackbox_exporter (through Prometheus and Alertmanager) for public reachability.
- Sentry for backend exception debugging.

For the first admin web version, include only a small system-status section:

- Backend reachable.
- Outbox failed/pending counts.
- Link to Grafana.
- Link to Sentry.

Keep deep operational analysis outside the admin console.
