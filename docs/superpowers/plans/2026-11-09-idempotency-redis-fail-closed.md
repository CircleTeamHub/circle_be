# Idempotency Redis Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent requests carrying `Idempotency-Key` from executing without replay protection when Redis is unavailable, and make production Redis readiness strict by default.

**Architecture:** Preserve backward compatibility for requests without `Idempotency-Key`. For keyed requests, reject before the business operation with HTTP 503 when the Redis claim cannot be established. Treat Redis as a production readiness dependency only when `REDIS_REQUIRED` is enabled, with production validation and generated deployment configuration defaulting it to enabled.

**Tech Stack:** NestJS, TypeScript, Jest, Joi, Redis/ioredis, Bash deployment configuration

## Global Constraints

- Do not change behavior for requests without `Idempotency-Key`.
- Do not add database migrations or claim strict transactional idempotency after the business write commits.
- Keep logs free of user IDs and raw idempotency keys.
- Preserve an explicit `REDIS_REQUIRED=false` operator override outside generated production configuration.

---

### Task 1: Fail closed for keyed requests and production readiness

**Files:**

- Modify: `src/idempotency/idempotency.service.spec.ts`
- Modify: `src/idempotency/idempotency.service.ts`
- Modify: `src/health/health.endpoint.spec.ts`
- Modify: `src/health/health.endpoint.ts`
- Modify: `src/redis/redis.service.ts`
- Modify: `src/config/env.validation.spec.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `src/config/redis-deploy.spec.ts`
- Modify: `deploy/gen-env.sh`
- Modify: `.env.production.example`
- Modify: `.env.example`

**Interfaces:**

- Consumes: `RedisService.setJsonIfAbsent()` returning `null` when Redis cannot answer.
- Produces: `RedisService.isRequired(): boolean`; readiness returns 503 only when Redis is required and not up.

- [x] **Step 1: Write failing tests**

  Replace the fail-open idempotency expectation with a 503 expectation that proves the operation is not called and the warning remains redacted. Add readiness coverage for required Redis being down, production validation coverage for Redis being required by default, and deployment-generation assertions for `REDIS_REQUIRED=true`.

- [x] **Step 2: Run tests to verify they fail**

  Run: `npm test -- --runInBand src/idempotency/idempotency.service.spec.ts src/health/health.endpoint.spec.ts src/config/env.validation.spec.ts src/config/redis-deploy.spec.ts`
  Expected: failures show the current fail-open operation execution, readiness 200 response, permissive production validation, and generated `REDIS_REQUIRED=false`.

- [x] **Step 3: Write minimal implementation**

  Throw `ServiceUnavailableException` when a keyed request cannot claim Redis; expose the configured Redis-required flag to readiness; gate readiness on required Redis; default production validation and generated production env files to required Redis; update configuration comments.

- [x] **Step 4: Run focused and broad verification**

  Run the focused Jest suites, `npm run build`, scoped ESLint without auto-fix, Prettier check for touched files, Bash syntax validation, and `git diff --check origin/main...HEAD`.

- [x] **Step 5: Review and commit**

  Review the complete diff for compatibility and redaction, then commit once with `fix(idempotency): fail closed without Redis`.

## Verification Notes

- The full `redis-deploy.spec.ts` Bash path is expected to remain unavailable on Windows when secure ACL clearing cannot be verified; run its platform-independent template assertion locally and rely on Linux CI for the ACL path.
