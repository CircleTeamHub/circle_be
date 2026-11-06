# R2 Public Media Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare a reviewable, public-prefix-only media Worker for the private preproduction R2 bucket.

**Architecture:** Validate the request once before any binding access. Use R2's native streaming, metadata and conditional/range APIs, and cache only complete public responses. The bucket never becomes public; private media continues through backend authorization.

**Tech Stack:** JavaScript with generated Env types, Wrangler 4.158.0, Cloudflare Workers types 5.20261106.1, Node test runner and local Miniflare runtime.

## Global Constraints

- GET and HEAD only. Public prefixes: avatars, covers, posts, friends, uploads.
- Deny private, unknown, malformed and encoded traversal paths before cache/R2 access.
- No real media, secrets or cloud writes in tests. No raw request URL/IP/provider errors in runtime logs.
- Binding MEDIA targets windnote-media-preprod only; rate limit 200 requests per 10 seconds per location.
- No publication or public exposure without the user's concrete resource/scope approval.

### Task 1: Request gate and streaming delivery

**Files:** `deploy/cloudflare/media-worker/src/index.js`, `src/index.test.mjs` within that component.

**Interfaces:** `worker.fetch(Request, Env, ExecutionContext): Promise<Response>`; Env is generated from Wrangler. HTTP output includes Content-Type/ETag/Content-Length/Last-Modified/Accept-Ranges, CORS for public reads, and correct 200/206/304/412 statuses. HEAD does not read an object body.

- [x] Write behavioral tests before implementation; run `node --test src/index.test.mjs` and observe the 501 stub failures (27 original failing tests).
- [x] Implement the gate, rate-limit binding, streaming R2 reads, HTTP metadata/conditions, canonical cache keys, cache-policy handling, and redacted failures.
- [x] Run `npm run types` and `npm run typecheck`; use the generated Env, not a handwritten binding interface.

### Task 2: Real local runtime checks and regression

**Files:** `src/index.integration.test.mjs`, `package.json`, `package-lock.json`, `wrangler.jsonc`, `tsconfig.json`, `worker-configuration.d.ts` within that component.

- [x] Exercise the actual Worker/R2 runtime using fixture-only local bindings, full/HEAD/ranged/suffix/conditional reads and private-prefix denials.
- [x] Reproduce range regression: actual R2 may include full-read range metadata and an undefined suffix property. Add unit regression coverage; observe two failures before correction.
- [x] Classify supported single byte ranges against selected metadata before native streaming reads; ignored ranges stay 200 and unsatisfiable ranges return 416.
- [x] Restrict edge-cache cloning to images up to 8 MiB; observe two regression failures for video/large-image caching before the fix.
- [x] Verify 40 tests pass, including cold-cache ETag and If-Match cases, and ensure runtime.dispose() closes the local helper.
- [x] Reproduce the review's warm-cache/HEAD precondition, If-Range and unsatisfiable-range bugs before fixing them; verify 84 component tests including 54 real local-runtime cases.
- [x] Reproduce equal-date conditional empty-body/cache contamination; use the shared local seconds-precision evaluator and an explicit body contract check. Verify 89 component tests and obtain final whole-branch review approval, subject to CI.
- [x] Run Wrangler dry-run to validate the real binding configuration without deployment.

### Task 3: Continuous verification and publication review

**Files:** `.github/workflows/ci.yml`, component `README.md`.

- [x] Add the component's install/type-generation check/test/typecheck/dry-run commands to the existing required CI job; no Cloudflare deploy credentials in CI.
- [x] Document scope, cache behavior, free-account deployment endpoint, no-write interface, and private-read separation.
- [ ] Complete independent spec/quality review, then request the concrete Worker creation/public-exposure approval.
- [ ] After approval, publish and bind the configured resources, verify public reads and private denials, and only then include its actual URL in the backend cutover.
