# AGENTS.md

## Repository context

This repository is a production NestJS backend using TypeScript, Prisma, PostgreSQL, Redis, JWT/Passport, CASL-style authorization, throttling, Sentry, Winston logging, Prometheus metrics, MinIO/S3 upload flows, LiveKit, OpenIM, and background/outbox processors.

Primary verification commands:

- `npm run build`
- `npm run lint`
- `npm test`
- `npm run test:e2e`
- `npm run test:redis`
- `npm run test:minio`

Use targeted commands when a PR only touches a small area, but call out when broader verification is needed because the change affects shared guards, DTOs, Prisma models, auth, logging, metrics, realtime, uploads, or background processing.

## Review guidelines

Perform a strict production-readiness review of each pull request. Review the changed diff and the surrounding code needed to understand the behavior, but keep feedback tied to concrete, actionable issues introduced or exposed by the PR.

Prioritize real production impact over style. Flag P0/P1 issues clearly, and include P2 issues only when they are specific and likely to matter. Do not nitpick formatting, naming, or small stylistic preferences unless they create a bug, security risk, maintainability risk, or operational problem.

For every finding, include:

- The specific bug, risk, or missing safeguard.
- Why it matters in production.
- The concrete endpoint, request shape, state transition, dependency failure, or concurrency case that triggers it when applicable.
- A focused fix direction.
- A test that should cover the issue when a test is reasonable.

Do not rewrite code or propose broad architectural rewrites during review. Recommend minimal, high-value fixes that preserve the PR's intent. Only make code changes when explicitly asked with a follow-up such as `@codex fix ...`.

### NestJS architecture

- Verify controllers stay thin and delegate business logic to services.
- Check that modules, providers, imports, and exports follow NestJS dependency injection patterns without duplicate providers or avoidable circular dependencies.
- Prefer feature-module boundaries over shared god services.
- Check that guards, pipes, interceptors, filters, scheduled jobs, gateways, and processors are placed in the right layer.
- Flag service locator patterns, property injection, request-scoped providers used without a strong reason, and hidden singleton state that can break under concurrency.

### DTO validation and API contracts

- Verify every route validates body, params, query, and headers through DTOs, pipes, or explicit schema checks.
- Check required vs optional fields, nested validation, arrays, enum validation, coercion, length/range limits, and safe defaults.
- Flag trusting client-provided IDs, role/status fields, ownership fields, timestamps, prices, credits, counters, or state transitions.
- Check response DTOs and serializers avoid leaking internal fields, private profile data, tokens, provider payloads, or implementation details.
- Verify status codes, error shapes, pagination, backward compatibility, and mobile-client compatibility for changed endpoints.

### Authentication and authorization

- Check every non-public endpoint has the right JWT guard and role/permission/ownership checks.
- Verify admin-only, circle/group ownership, friend/contact, membership, wallet/coin, upload, notification, call, note, and public-share flows enforce authorization server-side.
- Flag insecure direct object reference risks, privilege escalation, confused-deputy flows, and trusting frontend route or UI checks.
- For CASL or role guard changes, check both allow and deny cases, default-deny behavior, and tests for cross-user access attempts.

### Security and abuse prevention

- Check for injection risks, mass assignment, unsafe file paths, unsafe URLs, SSRF-like behavior, unsafe serialization, weak crypto/token handling, and insecure defaults.
- Flag leaked secrets, JWTs, security codes, phone/email, device identifiers, request bodies, signed URLs, private media URLs, chat content, or user PII in logs, errors, Sentry, metrics labels, or API responses.
- Verify upload and presigned URL flows validate file type, size, ownership, expiration, bucket/key scope, and object visibility.
- Check endpoints that send codes, create invites, submit applications, mutate wallet/coin state, upload media, report users, or trigger external calls for throttling and abuse protection.
- Treat dependency, Docker, build, Prisma, env, logging, and infrastructure changes as security-sensitive when they affect runtime behavior.

### Reliability and failure handling

- Check downstream calls to Redis, PostgreSQL/Prisma, S3/MinIO, OpenIM, LiveKit, push providers, email/SMS providers, and other external services for timeouts, cancellation, retry safety, and useful error mapping.
- Do not recommend retries for non-idempotent operations unless deduplication, idempotency keys, locks, or outbox semantics make retries safe.
- Verify partial failures are handled explicitly, especially multi-step writes mixed with external calls.
- Check rollback or compensation needs for user creation, group/circle membership, invites, notifications, upload finalization, wallet/coin actions, calls, and outbox processors.
- Flag swallowed errors, generic catch blocks, unbounded retries, retry storms, missing backoff, and failure paths that leave inconsistent state.

### Data consistency and transactions

- Check multi-step writes for Prisma transaction boundaries.
- Look for race conditions, duplicate submissions, double-spend/double-credit risks, lost updates, stale reads, and inconsistent counters.
- Verify unique constraints, indexes, idempotency keys, locking, and optimistic/pessimistic concurrency controls where needed.
- For migrations or Prisma schema changes, check backward compatibility, data loss risk, rollout order, nullability, defaults, indexes, and rollback safety.
- Watch for N+1 queries, unbounded result sets, missing pagination, and expensive joins or loops in request paths.

### Observability and operations

- Important success and failure paths should emit enough structured, redacted context for production debugging.
- Check Sentry context, Winston logs, request context, security/business/performance event logs, metrics, health checks, and audit-relevant events.
- Flag high-cardinality metrics labels, noisy logs, missing correlation/request IDs, and logs that would expose secrets or PII.
- For scheduled jobs and processors, check visibility into retries, dead letters, stuck work, duplicate work, and processing latency.

### Performance and scalability

- Check database query shape, indexes, pagination, batching, caching, repeated Prisma calls, Redis usage, memory growth, large payloads, and expensive synchronous work.
- Verify hot endpoints and realtime paths avoid blocking work, unbounded fanout, event storms, and per-request initialization of heavy clients.
- For upload, notification, call, OpenIM, LiveKit, and outbox flows, check throughput, backpressure, batching, and graceful degradation under dependency latency.
- Suggest optimizations only when tied to a plausible production bottleneck.

### Testing expectations

- Require focused tests for changed business logic, DTO validation, guards/permissions, service failure paths, Prisma transaction behavior, idempotency, rate limiting, external-service wrappers, processors, and API contracts.
- For regressions, request tests that would fail before the fix.
- Prefer NestJS TestingModule unit tests for services/guards and Supertest or existing e2e patterns for route contracts.
- Mock external services in unit tests. Integration tests that need Redis, MinIO, or other services should be called out explicitly.
- Do not accept only happy-path tests for security-sensitive, money/credit, membership, invitation, upload, auth, or notification changes.

### Review output style

- Lead with findings, ordered by severity.
- Keep summaries brief and secondary.
- Be direct and specific; avoid vague feedback like "improve validation" or "handle errors" without naming the exact route, DTO, service method, and failure mode.
- Avoid speculative comments. If a concern depends on an assumption, state the assumption.
- Prefer one precise comment over many overlapping comments.

