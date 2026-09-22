# Backend Observability Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent tasks, followed by specification and production-readiness reviews.

**Goal:** Make Circle backend failures and slow operations safely searchable from an HTTP request or background run through its diagnostic events.

**Architecture:** Extend the existing Winston, AsyncLocalStorage, Prisma adapter, tracked cron, Sentry, and Grafana stack. Use a single bounded log sanitizer and structured events; add optional private Loki/Alloy collection with durable, per-colour application log volumes.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL, Winston, Jest, Docker Compose, Grafana Loki/Alloy.

## Global Constraints

- Base: origin/main at 94ebce7; work only in this isolated backend checkout.
- Preserve API responses, business transactions, auth rules, and existing monitoring.
- Never record tokens, contact details, bodies, chat content, SQL text, parameters, signed URLs, or arbitrary exception messages.
- Keep diagnostic IDs in log fields, never Prometheus or Loki labels.
- Do not deploy, restart production, publish credentials, or change running services.
- Verify privacy and failure isolation with regression tests before implementation.

## Task 1: Safe structured output

Files: `src/logging/log-sanitizer.ts`, `winston-options.ts`, event logger helpers and corresponding specs.

Interfaces: `sanitizeLogValue(value: unknown): unknown`, `sanitizeLogText(value: string): string`, `safeLogPath(path: string): string`.

- [x] Test nested secrets, path tokens, error SQL, cycles/getters, oversized inputs, no mutation, and actual Nest/Winston serialized output.
- [x] Implement bounded sanitization before console/file formatting; preserve error type and stack locations, remove free-form exception data.
- [x] Emit timestamped JSON in production; retain readable development output and allow file logging to be disabled independently.
- [x] Run `npm test -- --runInBand log-sanitizer winston-options business-event.logger security-event.logger external-service.logger`.

## Task 2: HTTP lifecycle and failure diagnostics

Files: request middleware/context, HTTP interceptor and exception filters, rate limiter, setup, and focused specs.

- [x] Test safe paths, context even with access logging disabled, aborted responses, exactly-once terminal events, concurrent isolation, and throwing transports.
- [x] Always establish correlation, use monotonic timing, log premature closes, omit request/query/contact data, and sanitize unknown routes.
- [x] Emit one structured HTTP failure per exception; expected 4xx at warn, unexpected 5xx at error. Preserve response envelopes and Sentry de-duplication even when logging throws.
- [x] Run `npm test -- --runInBand request-context request-logger rate-limit-logger error-logging all-exception prisma-exception setup.spec`.

## Task 3: Database and background execution

Files: Prisma service, new database observability helper, tracked-cron decorator, operation-context helper, and specs.

Interfaces: `getOperationContext(): Readonly<{job: string; runId: string}> | undefined` and `runWithOperationContext<T>(context, run: () => T): T`.

- [x] Test threshold boundaries, success/failure preservation, no SQL/parameter leakage, transaction compatibility, and concurrent job contexts.
- [x] Add opt-out slow-operation timings through a supported Prisma adapter seam, with bounded operation metadata only.
- [x] Give each cron execution a random runId and structured terminal result; healthy summaries at debug, failures at warn/error, preserving current metrics.
- [x] Run focused Prisma, database-observability, operation-context and tracked-cron tests.

## Task 4: Durable centralized log retrieval

Files: optional monitoring log overlay, Loki/Alloy config, Grafana datasource, production/release log volumes, collection runbook and tests.

- [x] Confirm current official Loki/Alloy configuration and pin compatible image versions.
- [x] Persist separate blue/green log volumes, collector offsets and Loki storage; avoid Docker socket privileges.
- [x] Configure private ingestion/query endpoints, retention and a bounded label allowlist.
- [x] Verify merged Compose and validate configs with the actual binaries where available. Document enablement, query examples, recovery and rollback.

## Task 5: Integration and review

- [x] Add validated environment switches and align logging/observability docs with actual behavior.
- [x] Run affected tests, backend build, non-mutating lint, then full unit tests.
- [x] Independently review specification compliance and production risks; fix verified findings and rerun affected checks.
- [x] Report verified results and distinguish local validation from live deployment.


## Verification record (2026-09-22)

- Production build: `npm run build` passed.
- Full non-mutating lint: `npx eslint "{src,apps,libs,test}/**/*.ts" --quiet` passed (no errors; targeted runs still report advisory warnings).
- Portable unit regression: 289 suites / 3,666 tests passed; 2 suites / 7 tests already skipped. Command: `npm test -- --runInBand --silent --testPathIgnorePatterns='redis-deploy.spec.ts|monitoring-blackbox-exporter.spec.ts'`.
- Those two excluded deployment suites were run separately in an isolated Node 24 Linux container using a temporary LF-normalized source copy: 2 suites / 12 tests passed. On the Windows checkout their four failures were the script's explicit unsupported-ACL-platform guard and existing LF-only fixture regexes; production code/test expectations were not weakened.
- Added regressions were observed failing before implementation: nested secrets/SQL/path tokens, log sink failures, aborted responses, disabled-output context, hostile exception getters, Sentry environment overrides and automatic path tags, transaction preservation, cron context isolation, critical startup event identity, and legacy error-message leaks.
- Native Loki/Alloy config validation and private synthetic ingestion passed: blue/green files, rotation discovery, restart offsets, bounded labels and Grafana read-only datasource mount. Temporary containers and source fixtures were removed.
- Independent cross-reviews covered HTTP integration, safe output, Prisma/job behavior and deployment configuration. Findings were fixed and relevant tests rerun.
- A final independent targeted recheck confirmed the reported raw-exception leaks in chat, circle synchronization, friend replay and Geo diagnostics were resolved. The full portable suite, build and lint above were rerun after these fixes.

### Boundaries and handoff

- All changes are local to the `codex/circle-be-observability` worktree. No commit, push, merge, deployment, production restart, credential change or database migration was performed.
- The real Prisma client/adapter transaction tests mock only the PostgreSQL network boundary. Full application E2E against live PostgreSQL/Redis/object storage was not run; run the existing dependency-backed checks in staging before release.
- Log collection is opt-in. Follow `monitoring/logs.md` before activating it; provision both color volumes and validate permissions. Single-host Loki and experimental Alloy sender WAL are not a lossless audit archive.
- Arbitrary legacy prose cannot be perfectly classified by regex. New diagnostics must use deliberately selected structured fields; central redaction is defense in depth.
