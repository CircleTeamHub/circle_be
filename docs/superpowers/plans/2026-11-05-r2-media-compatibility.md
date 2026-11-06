# R2 Media Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the backend for a private R2 bucket using a bucket-scoped object credential, while retaining recognition of historical COS media URLs.

**Architecture:** Keep S3 signing and authorization unchanged. Explicit operator verification of R2 bucket configuration replaces the unavailable administrative lifecycle read; actual browser upload CORS remains checked through unsigned OPTIONS preflights. Normalize legacy storage bases once in environment validation and share the recognized bases with UploadService and existing consumers.

**Tech Stack:** NestJS, TypeScript, Joi, AWS SDK v3, Jest.

## Global Constraints

- Source objects have been copied without deletion: 403 objects, 706898511 bytes, each SHA-256 and metadata verified.
- Keep `chat/`, `notes/`, `note-exports/`, and `stickers/` private.
- Public delivery may expose only `avatars/`, `covers/`, `posts/`, `friends/`, and `uploads/`.
- Never place real access keys or media object paths in source, logs, or this plan.
- No production configuration or database changes before a concrete cutover review.
- Existing S3/COS behavior remains the default; no automatic fallback on 403.

### Task 1: Historical storage-base recognition

**Files:** `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `src/utils/storage-url.ts`, `src/utils/storage-url.spec.ts`, `src/upload/upload.service.ts`, `src/upload/upload.service.spec.ts`, `.env.example`.

**Interfaces:** `OBJECT_STORAGE_LEGACY_PUBLIC_URLS` accepts comma-separated HTTP/HTTPS bases at the environment boundary and becomes `string[]` internally. `storagePublicObjectBasesFromConfig()` appends those bases after the canonical and current signing bases. UploadService consumes that same list.

- [x] Add failing tests for normalized legacy bases, rejection of credential/query/fragment-bearing bases, suffix-host rejection, and UploadService extracting keys from historical COS URLs after a bucket-name change.
- [x] Run `npm test -- --runInBand src/config/env.validation.spec.ts src/utils/storage-url.spec.ts src/upload/upload.service.spec.ts`; confirm new tests fail on missing behavior.
- [x] In environment validation, import `normalizeStorageDeliveryBase` and add:

```ts
OBJECT_STORAGE_LEGACY_PUBLIC_URLS: Joi.string()
  .empty('')
  .custom((value: string, helpers) => {
    const bases = value.split(',').map((item) => item.trim()).filter(Boolean)
      .map((item) => normalizeStorageDeliveryBase(item));
    if (bases.some((base) => base === null)) return helpers.error('any.invalid');
    return [...new Set(bases)];
  })
  .default([]),
```

- [x] Before returning recognized bases, append each configured typed legacy base once:

```ts
for (const base of config.get<string[]>('OBJECT_STORAGE_LEGACY_PUBLIC_URLS') ?? []) {
  if (!bases.includes(base)) bases.push(base);
}
```

- [x] Replace UploadService's independently constructed recognition list with `storagePublicObjectBasesFromConfig(this.config)`, retaining its current public-base fallback when storage is unconfigured.
- [x] Re-run the focused tests and lint the changed TypeScript files.

Evidence: commit `3b92199` (`feat(storage): recognize historical public object bases`).
The focused RED run had 12 expected failures; GREEN passed 3 suites / 153 tests.
Scoped ESLint exited 0 with five warnings (no errors).

### Task 2: Least-privilege R2 bootstrap

**Files:** `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`, `src/upload/upload.service.ts`, `src/upload/upload.service.spec.ts`, `.env.example`.

**Interfaces:** `OBJECT_STORAGE_BUCKET_CONFIG_VERIFIED_EXTERNALLY` defaults to false. True is valid only for an externally managed HTTPS R2 API endpoint; it is an explicit operator attestation that the one-day export lifecycle and private bucket access have been checked. It does not declare `objectStoreStatus()` verified.

- [x] Add failing tests for explicit R2 opt-in with a bucket-only client, failed CORS preflight, default S3 lifecycle enforcement, and invalid opt-in on a managed/non-R2 bucket.
- [x] Confirm new focused tests fail before implementation.
- [x] Add the boolean field and this cross-field validation to the existing environment schema boundary:

```ts
if (value.OBJECT_STORAGE_BUCKET_CONFIG_VERIFIED_EXTERNALLY &&
    (value.OBJECT_STORAGE_MANAGE_BUCKET ||
     !/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com\/?$/.test(value.MINIO_ENDPOINT ?? ''))) {
  return helpers.message({ custom: 'OBJECT_STORAGE_BUCKET_CONFIG_VERIFIED_EXTERNALLY requires an externally managed HTTPS R2 endpoint' });
}
```

- [x] Read the boolean once in UploadService. Under explicit opt-in only, omit `GetBucketLifecycleConfiguration`; preserve `HeadBucket`, the external-unverified status, and the required controlled delivery URL.
- [x] Retain the existing direct signing object base as a readonly property. Under opt-in, check each ALLOWED_ORIGINS entry with:

```ts
const response = await fetch(`${this.directPublicObjectBase}/uploads/__cors_probe__`, {
  method: 'OPTIONS',
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type,if-none-match',
  },
});
const rule = {
  AllowedOrigins: [response.headers.get('access-control-allow-origin') ?? ''],
  AllowedMethods: (response.headers.get('access-control-allow-methods') ?? '').split(',').map((item) => item.trim()),
  AllowedHeaders: (response.headers.get('access-control-allow-headers') ?? '').split(',').map((item) => item.trim()),
};
if (!response.ok || !corsRuleAllowsBrowserPut(rule, origin)) {
  throw new Error('External R2 storage does not pass browser upload preflight');
}
```

- [x] Keep the existing metadata-read CORS check for all default S3/COS configurations.
- [x] Verify focused tests, TypeScript build, and relevant lint checks. Document that lifecycle verification is manual in this explicit mode; never silently treat AccessDenied as success.

Evidence: commit `fdf8db2` (`feat(storage): verify attested R2 browser upload CORS`).
RED had 18 expected failures; GREEN passed 3 suites / 175 tests. Scoped ESLint
exited 0 with the same five warnings. The controller's full backend build passed
after generating the ignored Prisma client; the initial missing-client build
failure is retained in the task evidence. No cloud or database cutover occurred.

### Task 3: Cutover prerequisites and review

**Files:** `docs/runbooks/r2-media-cutover.md`, `.env.example`.

- [x] Document the exact R2 endpoint, bucket name, region `auto`, path-style true, managed-bucket false, and the two new configuration fields; credential values are supplied through the existing secure deployment flow.
- [x] Document the public-prefix-only delivery Worker as a separate deployable component. It must pass deny tests for private prefixes before publishing.
- [x] Document that legacy recognition alone does not rewrite stored public URLs. Require a database dry run and backup of affected scalar, array and card-avatar fields before changing their delivery base.
- [x] Require a final incremental inventory check, controlled upload pause, private-media authorization tests, browser PUT preflight/upload verification, and rollback using the retained COS configuration.
- [ ] Prepare a ready-for-review PR; keep deployment and permanent source cleanup separate from code preparation.

Evidence: [cutover runbook](../../runbooks/r2-media-cutover.md) documents the
reviewed resources, exact HTTPS origin set, deployment secret flow, mapped-field
dry run/backup and pending operator gates. `.env.example` already documents both
new fields and needs no further correction. Worker commit `ff004ad` has 40 passing
fixture-only unit/local-runtime tests, generated-type and TypeScript checks, and
a successful Wrangler dry run; see its [implementation plan](2026-11-05-r2-public-delivery.md).
This checklist records code/documentation preparation only. PR publication is
pending controller integration; the Worker is not deployed, storage has not
switched, and the runbook's live-operation checkboxes remain open.
