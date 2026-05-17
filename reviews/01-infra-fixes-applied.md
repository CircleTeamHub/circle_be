# Phase 0 — Fixes Applied

> Companion to [`01-infra.md`](./01-infra.md). Lists what was actually changed,
> what was deferred and why, and what still requires user action.

**Verification**: `npx tsc --noEmit` 0 errors · `jest` 27 suites / 118 tests pass.

---

## ✅ Applied

| Finding | File | Change |
|---|---|---|
| #1 (.env tracked) | `.gitignore`, `.dockerignore`, `.env.example` | Added `.env*` + `!.env.example` to both ignores; rewrote `.env.example` with full template (JWT_EXPIRES_IN, ALLOWED_ORIGINS, MINIO note) |
| #1 (.env tracked) | tracked files | `git rm --cached .env .env.development .env.production .env.test` — files stay on disk untracked |
| #2 (LogsModule break) | `src/app.module.ts` | Removed `import { LogsModule }` and the `LogsModule` entry in `imports` array |
| #2 / #12 (winston wiring) | `src/setup.ts` | Removed `WINSTON_MODULE_NEST_PROVIDER` import + the `app.useLogger(...)` call; project uses Nest's default ConsoleLogger now |
| #3 (ValidationPipe) | `src/setup.ts` | Added `forbidNonWhitelisted: true` + `disableErrorMessages` gated by production |
| #4 / #5 (AllExceptionFilter leak) | `src/filters/all-exception.filter.ts` | Rewrote with Pattern E — scrubs `password`/`token`/`authorization`/`cookie`/...; never reflects request headers/body in response; logs trimmed payload with userId + ip + path; client only gets `{ code, message, data: null }` |
| #4 / #5 | `src/setup.ts` | Registered `AllExceptionFilter` (was commented out); kept `PrismaExceptionFilter` |
| #7 (dev CORS=true) | `src/main.ts` | New `resolveCorsOriginChecker` — production uses ALLOWED_ORIGINS only; dev/test adds localhost + 10.x + 192.168.x regex; rejects any other origin |
| #8 (Prisma filter default silent) | `src/filters/prisma-exception.filter.ts` | Default branch now logs full Prisma error code + meta + path; `P2002` returns conflicting field names in `data.conflict` |
| #13 (env validation weak) | `src/config/env.validation.ts` | `SECRET` `.min(32)` in production, `.min(8)` otherwise; added `JWT_EXPIRES_IN`, `REFRESH_EXPIRES_IN` (with sane defaults); `APP_PORT` `.integer().min(0).max(65535)`; `.unknown(true)` to tolerate ops-only keys |
| #16 (Swagger always on) | `src/main.ts` | Swagger only mounted when `NODE_ENV !== 'production'` |
| #11 (two lockfiles) | repo root | `git rm package-lock.json` — pnpm-lock.yaml is the source of truth |
| #19 (dead http-exception filter) | `src/filters/http-exception.filter.ts` | Deleted (was never registered) |
| LOW (hello-world test) | `src/test.spec.ts` | Deleted |
| #10 (Dockerfile Node 14 / nginx misuse) | `Dockerfile`, `Dockerfile.prod` | Both bumped to `node:22-slim`; prod is a real multi-stage build using `pnpm`, copies `dist/` + `node_modules/` + `prisma/` + `src/generated/`, runs as non-root `app` user, starts via `node dist/src/main.js`; dev uses `pnpm run start:dev` |
| #10 (.dockerignore) | `.dockerignore` | Added `.env*` block so secrets never leak into images |
| pnpm 10 build-script approvals | `package.json`, `.npmrc` | Expanded `pnpm.onlyBuiltDependencies` to include `prisma`, `@prisma/engines`, `@nestjs/core`, `@scarf/scarf`, `unrs-resolver`; removed the broken JSON-in-INI from `.npmrc`, replaced with `auto-install-peers=true` |
| `setup.spec.ts` | `src/setup.spec.ts` | Updated to assert new global filter registration + ValidationPipe; uses `httpAdapter` mock so AllExceptionFilter ctor doesn't blow up |

---

## ⏸️ Deferred — full inventory (everything from `01-infra.md` not touched)

Grouped by severity. Each row says **what** + **why deferred** + **suggested owner / phase**.

### HIGH (still open)

| ID | Where | Issue | Why deferred |
|---|---|---|---|
| #6 | `tsconfig.json:14-18` | `strictNullChecks: false`, `noImplicitAny: false`, `strictBindCallApply: false`, `forceConsistentCasingInFileNames: false` — type safety degraded | Flipping each flag triggers 100+ errors across `friend/note/circle*` services. Needs a dedicated tightening branch with file-by-file fixes; not a Phase-0-style minimal patch |
| historic-secret | git history of `.env*` | Secrets remain in every past commit blob; `git rm --cached` only stops future commits | Decided to skip `git filter-repo` because repo is private. User confirmed scope. Rotation is still the only true mitigation if a credential was ever actually deployed |
| §5 `app.module.ts` config | `.env.production` field names (`DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD`) don't match `env.validation.ts` (which only reads `DATABASE_URL`) | Requires the user to rebuild a real `.env.production` from the new `.env.example` (now untracked) — we can't author it without real values |

### MEDIUM (still open)

| ID | Where | Issue | Why deferred |
|---|---|---|---|
| #14 | `src/guards/casl.guard.ts:38` | `await caslAbilityService.forRoot(role)` lacks `try/catch` — a `forRoot` throw 500s instead of 403 | Will revisit during Phase 1 once we see whether `forRoot` realistically throws. Trivial 3-line patch — held to keep Phase 0 scoped |
| #15 (partial) | `src/interceptors/response.interceptor.ts:27` | Success envelope `{ code:0, message:'ok', data }` vs error envelope `{ code:HTTP_STATUS, message, data }` — `code` semantic differs | Unifying is a frontend-coupled decision (clients parse both shapes). Phase 9 (cross-cutting) will collect a proposal |
| §3-MED | `src/setup.ts:131` | `/api/v1/note` rate limiter (60 ops / 15 min / IP) covers **all methods** including GET — heavy browsers will hit it | Need to split read vs write before tightening; held until Phase 4 (note review) confirms the GET shape |
| §3-LOW→MED | `src/setup.ts:122-145` | 4 inline `(req:any, res:any, next:any) => …` middleware blocks duplicate logic | Cosmetic refactor — would extract `methodLimiter(limiter, methods)`. Held to keep diff small |
| §9-MED | `src/config/env.validation.ts:43-47` | `OPENIM_*` and `MINIO_*` all `.optional()` even though `UploadModule` will 500 without MinIO at runtime | Need cross-module proof that those envs are actually required before forcing them in. Deferred to Phase 7 (upload) and Phase 8 (openim) |
| §11-MED | `src/config/server.config.ts` | Redundant with `ConfigModule`'s `envFilePath` + `load:` — same envs parsed in 4 places (`main.ts`, `setup.ts` removed, `server.config.ts`, `prisma.config.ts`) | `server.config.ts` is also imported by `PrismaService`. Consolidation has fan-out; tracked for Phase 9 |
| §14-MED | `src/filters/prisma-exception.filter.ts` | Only catches `PrismaClientKnownRequestError`; doesn't handle `PrismaClientValidationError`, `PrismaClientUnknownRequestError`, `PrismaClientInitializationError` (DB down) | Each needs an HTTP mapping decision. Will add when we encounter the first user-reported instance |
| winston log stack | n/a | The full structured-logging foundation (winston + request-id + middleware, ~800 LOC) lives on `codex/dev-test-logging` and was never merged | Merging that branch is a separate decision (it changes many service-side log calls). Out of scope for "fix the bugs" |
| §1-MED | `src/main.ts` + `src/setup.ts` | Two env-parsing sources — `main.ts` calls `getServerConfig()` directly while `app.module.ts` uses `ConfigModule` | Same fan-out as `server.config.ts` issue above. Phase 9 |
| §15-LOW→MED | `src/interceptors/response.interceptor.ts:27` | No `requestId` / no `timestamp` in envelope — hard to correlate logs with a client report | Wait for winston decision; if we adopt request-id middleware, this becomes natural |

### LOW (still open)

| ID | Where | Issue | Why deferred |
|---|---|---|---|
| #20 | `src/decorators/casl.decorator.ts:18` | typo `CheckPolices` → `CheckPolicies` | Global rename touches every controller using `@CheckPolices(...)`; do as one focused refactor commit after Phase 1 confirms call-site count |
| #21 | `src/guards/jwt.guard.ts:4-6` | Empty `constructor()` is redundant | Cosmetic |
| #23 | `src/prisma/prisma.service.ts:31` | `allowsStartWithoutDatabase(process.env)` doesn't gate on `NODE_ENV !== 'production'` — degraded boot is accepted in prod | Trivial fix but I held it: changes behavior in a way the user may rely on for emergency deploys. Confirm before tightening |
| #24 | `src/enum/config.enum.ts` | Re-declares env keys (`DATABASE_URL`, `SECRET`, `LOG_LEVEL`, …) that also live in `env.validation.ts` — drift-prone | Pick one source-of-truth (probably delete the enum); deferred until we confirm no consumer relies on the enum |
| §1-LOW | `src/main.ts:30` | `bootstrap()` has no top-level `try/catch` — init failure prints raw stack | Nest's `NestFactory.create` rejection is logged by Node anyway; cosmetic |
| §1-LOW | `src/main.ts:5` | `module-alias/register` is brittle vs `tsconfig.paths` (already covered) — risk of dist-path mismatch in prod start | Held until we have a real prod build to inspect |
| §2-LOW | `src/main.spec.ts` | Only 2 `resolveAppPort` cases — missing 0 / 65535 / negative / float / empty / null edge cases | Test coverage; can add anytime |
| §3-LOW | `src/setup.ts:104` | `app.use(helmet())` uses defaults — no explicit CSP / HSTS tuning | Need to know which CDNs / 3rd-party hosts the frontend actually loads from |
| §4-LOW | `src/setup.spec.ts` | Mocks with `as any`; interface drift won't break the test | Will tighten when refactoring `setupApp` signature |
| §5-LOW | `src/app.module.ts:28` | `load: [() => dotenv.config(...)]` is duplicative with `envFilePath` | Cosmetic — fix during env consolidation |
| §7 / §8 | `src/swagger.spec.ts`, `src/package.spec.ts` | Smoke-only tests, low value, but harmless | Keep as cheap smoke until they break |
| §9-LOW | `src/config/env.validation.ts:7-9` | `readBooleanEnvFlag` accepts `"true"`/`"TRUE"` but not `"1"` or `"yes"` — surprises ops | Cosmetic — joi's `Joi.boolean()` already accepts more forms for declared boolean fields |
| §10-LOW | `src/config/env.validation.spec.ts` | Missing: SECRET-missing test, NODE_ENV=production + ALLOWED_ORIGINS-missing test, SECRET-too-short test | Test coverage backlog |
| §11-LOW | `src/config/server.config.ts:5` | Sync `fs.readFileSync` at function call (not module load) — fine for now, but blocks on slow filesystems | Cosmetic |
| §12 verified | `src/filters/all-exception.filter.ts` (old) | Originally typo'd `exceptioin`, used `exception['response']`, dumped headers | Fully rewritten — no longer applicable |
| §15-LOW | `src/interceptors/response.interceptor.ts:21` | `_context` parameter unused; intentional underscore prefix to silence lint | Acceptable |
| §16-LOW | `src/interceptors/serialize.interceptor.ts:12` | `ctor(private dto: any)` should be `ClassConstructor` | Cosmetic |
| §16-LOW | same | Two stale commented `console.log` lines | Cosmetic |
| §17-LOW | `src/guards/jwt.guard.ts:9-10` | `// 装饰器 @JwtGuard()` noise comment | Cosmetic |
| §18-LOW | `src/guards/admin.guard.ts` | No multi-role / no `isAdmin` flag support — single string compare | Wait until role system actually grows |
| §20-LOW | `src/guards/casl.guard.ts:44-57` | Repeated `instanceof Array` / `typeof === 'function'` branches can be abstracted | Cosmetic |
| §21-23 LOW | `src/guards/__tests__/*.spec.ts` | Missing cases: no-metadata path, `req.user` missing, `forRoot` throws | Test coverage backlog |
| §26-LOW | `src/decorators/serialize.decorator.ts:4-6` | Local `ClassConstructor` interface should be hoisted to `types/` | Cosmetic |
| §29-LOW | `src/prisma/prisma.service.ts:33-37` | URL string isn't format-validated; an empty-string vs malformed URL differ | Trivial Joi extension; held to keep env validation diff small |
| §29-LOW | `src/prisma/prisma.service.ts:87-111` | `connectIfNeeded` has no mutex — concurrent retries can race | Has never been observed; add only if `degraded-boot` becomes load-bearing |
| §29-LOW | `src/prisma/prisma.service.ts:67` | Log message lacks `[Prisma]` prefix | Cosmetic |
| §30-LOW | `src/prisma/prisma.service.spec.ts` | Missing: connect-failure-non-degraded rethrow path, `connectIfNeeded` happy/sad | Test coverage backlog |
| §31-LOW | `tsconfig.json` | `ignoreDeprecations: "6.0"` is a temporary escape hatch | Resolve when bumping `typescript` major |
| §33-PARTIAL | `Dockerfile` (dev) | Now `node:22-slim` + pnpm, but still single-stage (intentional for dev) | Acceptable |
| Multiple | `src/setup.ts` legacy `// app.useGlobalGuards()` etc. comments | Removed in rewrite | Done |

### Withdrawn / false positive

| ID | Why withdrawn |
|---|---|
| #9 (friend report limiter "double hit") | `app.use('/api/v1/friend/requests', mw)` is a strict prefix match; `/api/v1/friend/:id/report` doesn't share that prefix, so the two limiters never co-fire. Original finding was wrong |

---

## 🚨 Required follow-up actions (user)

1. **Rotate** every value that ever lived in `.env*` committed history — at minimum:
   - `SECRET` (JWT signing key)
   - Postgres password (`DB_PASSWORD` in `.env.production`)
   - MinIO `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`
2. Decide on history rewrite (`git filter-repo --invert-paths --path .env --path .env.development --path .env.production --path .env.test`) **only** if you control all remotes and can force-push.
3. Rebuild `.env.production` from `.env.example` template — current file uses obsolete `DB_HOST` style fields that no longer match `env.validation.ts`.

---

## Verification log

```
$ npx tsc --noEmit
(no errors)

$ npx jest --testPathIgnorePatterns="test/"
Test Suites: 27 passed, 27 total
Tests:       118 passed, 118 total
```
