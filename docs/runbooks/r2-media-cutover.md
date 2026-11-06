# Preproduction R2 media cutover

## Optional signed download compatibility gateway

`OBJECT_STORAGE_SIGNED_DOWNLOAD_PROXY_BASE` is disabled when unset or empty.
To reuse an origin already trusted by installed clients, set it to an HTTPS
base such as `https://api.example.com/r2-media` only after preparing a read-only
API/Caddy gateway. Its origin must already be an exact `ALLOWED_ORIGINS` entry,
and `OBJECT_STORAGE_FORCE_PATH_STYLE` must be `true`. Credentials, query strings
and fragments in this base are rejected at startup; trailing slashes normalize
away. This setting does not change the canonical public delivery base.

The backend still signs GET against the existing R2 S3 endpoint, bucket, key,
signing date and TTL. It only prefixes the signed path and unchanged query with
the gateway base. The gateway must strip `/r2-media`, preserve the encoded path,
raw signature query and Range headers, and restore the original R2 Host before
forwarding. Do not sign for the API host, enable gateway PUT, weaken private
authorization, or expand the five public prefixes. PUT signatures and uploads
remain direct R2. Keep existing private-media authorization before issuing GET
URLs; this gateway does not replace it.

Every signed URL is a bearer credential: suppress full URLs and query strings
in gateway, application, analytics and error logs. Transfer through the API uses
the existing server traffic allowance; this is not a promise of free bandwidth.
Verify signed GET, byte ranges and private denial through the gateway before
enabling the variable. Unsetting it restores direct signed GET URLs without a
storage migration or a native rebuild.

Signing reference: [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Status on 2026-11-05: backend compatibility is in ready-for-review
[PR #312](https://github.com/CircleTeamHub/circle_be/pull/312). The source copy
contains **403 objects, 706898511 bytes**, verified with full SHA-256 hashes and
metadata. This is a historical checkpoint: reconcile again at cutover.
After separate user approval, the public delivery Worker was deployed and passed
live image/hash/cache, video-range and private-prefix denial checks. Its verified
endpoint is `https://windnote-media-preprod-delivery.yiboding1998.workers.dev`,
version `54abd6c9-1467-4054-907c-cdcdf41dd872`. The single-Worker temporary deployment
token was deleted after publication. Application storage has **not switched**,
and no database URL migration has been performed.

## Reviewed resources and configuration

| Setting | Cutover value |
| --- | --- |
| Cloudflare account | `0bea489023c1d8692a19dadaf15dcf95` |
| `MINIO_ENDPOINT` | `https://0bea489023c1d8692a19dadaf15dcf95.r2.cloudflarestorage.com` |
| `MINIO_PUBLIC_URL` | `https://0bea489023c1d8692a19dadaf15dcf95.r2.cloudflarestorage.com` |
| `MINIO_BUCKET` | `windnote-media-preprod` |
| `OBJECT_STORAGE_REGION` | `auto` |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | `true` |
| `OBJECT_STORAGE_MANAGE_BUCKET` | `false` |
| `OBJECT_STORAGE_BUCKET_CONFIG_VERIFIED_EXTERNALLY` | `true`, only after the manual checks below |
| `OBJECT_STORAGE_LEGACY_PUBLIC_URLS` | `https://windnote-preprod-tokyo-1447743949.cos.ap-tokyo.myqcloud.com,https://api-43-134-85-95.sslip.io/circle` |
| `OBJECT_STORAGE_DELIVERY_URL` | Verified `https://windnote-media-preprod-delivery.yiboding1998.workers.dev`; recheck before activation |

Both `MINIO_*URL` values above are the S3 API endpoint without a bucket suffix.
Path-style signing appends the bucket. Uploads and authorized private reads use
that endpoint; only permanent public reads use the separate Worker delivery base.
The Worker URL has no bucket suffix.

Read-only verification of the existing deployment found both `MINIO_ENDPOINT`
and `MINIO_PUBLIC_URL` set to `https://cos.ap-tokyo.myqcloud.com`, bucket
`windnote-preprod-tokyo-1447743949`, and `OBJECT_STORAGE_DELIVERY_URL` set to
`https://api-43-134-85-95.sslip.io/circle`. Preserve both the historical
bucket-hosted COS base and this current controlled delivery base in the legacy
list when activating the Worker. The `/circle` path is part of that old base,
not part of the object key. These configuration observations establish no
database row counts or actual stored-URL distribution.

The two new backend fields are opt-ins:

- `OBJECT_STORAGE_LEGACY_PUBLIC_URLS` defaults to an empty array internally.
  Environment input is comma-separated HTTP/HTTPS object bases, normalized and
  deduplicated once. Credentials, query strings and fragments are rejected.
  Recognition permits historical references to remain valid for authorization,
  key extraction and auditing; it does **not** rewrite any persisted public URL.
- `OBJECT_STORAGE_BUCKET_CONFIG_VERIFIED_EXTERNALLY` defaults to `false`. `true`
  is valid only with an externally managed HTTPS R2 API endpoint. It records an
  operator attestation and skips lifecycle/CORS metadata reads unsupported by the
  bucket-scoped credential. `HeadBucket` and actual browser PUT preflights remain
  required. Storage status remains `external-unverified`; an AccessDenied failure
  in the default S3/COS mode never becomes success automatically.

Keep the existing `ALLOWED_ORIGINS` equal to the reviewed Cloudflare bucket CORS
origin set, with these exact HTTPS origins and no wildcard or extra origin:

```dotenv
ALLOWED_ORIGINS=https://admin-43-134-85-95.sslip.io,https://app-43-134-85-95.sslip.io,https://chat-43-134-85-95.sslip.io,https://api-43-134-85-95.sslip.io
```

Require PUT with `content-type` and `if-none-match` for every origin. The reviewed
configuration previously returned unsigned OPTIONS 204 responses; repeat the
functional checks at cutover rather than relying on that checkpoint.

## Secure deployment preparation

Follow the existing [automatic release procedure](../operations/tencent-auto-deploy.md)
and [release-channel hardening](../release-hardening-runbook.md). Supply the
bucket-scoped object credential through the deployment host's excluded
`.env.production` as `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`, using the existing
administrator/secret-management path. Keep the retained COS configuration and
credentials in the password manager for rollback. Never put credentials, real
media object paths, signed URLs, private inventory contents or database row
values into this repository, PR, shell history, CI output or ordinary logs.

Preserve the existing secret-file permissions: Compose `.env` is `0600`;
`.env.production` is `0640`, restricted to the deployment account and its private
`APP_ENV_GID` group for the non-root container's read-only mount. Stage secret
edits at `0600`, apply the existing ownership/group controls before atomic
replacement, and retain protected recovery copies. Use the release flow for any
legacy permission migration. Do not print the environment to validate it.

Remove only `bundled-storage` from `COMPOSE_PROFILES` when selecting external
storage; preserve the host's Redis and proxy configuration. Keep host-local
Compose/Caddy files under `.release` as the deployment procedure requires.
Review the final effective configuration privately before restart, including
both S3 endpoint values; do not overwrite it with generated MinIO defaults.
Use the existing immutable-image, backup, standby validation and traffic-switch
release path for backend code. Cloudflare publication and the data/configuration
cutover require their own reviewed operator change.

## Delivery and bucket prerequisites

The [public media Worker](../../deploy/cloudflare/media-worker/README.md) is a
separate deployable component at `deploy/cloudflare/media-worker`, configured in
[wrangler.jsonc](../../deploy/cloudflare/media-worker/wrangler.jsonc). Its name is
`windnote-media-preprod-delivery`, its `MEDIA` binding targets only
`windnote-media-preprod`, and its per-location rate-limit binding permits 200
requests per ten seconds. Backend releases do not publish this Worker.

Before publication, run the component README's local verification commands and
review the private-prefix deny tests. They use fixture-only local R2 and a
Wrangler dry run. The implementation permits GET/HEAD only for **`avatars/`,
`covers/`, `posts/`, `friends/`, `uploads/`**, rejects other paths before cache or
R2 access, and streams responses with metadata, conditional reads and ranges.
Do not broaden the prefix allowlist to make a failed migration appear healthy.

Before enabling the external-verification flag, record operator verification in
the protected operational change record:

- Bucket public access and the R2 development URL (`r2.dev`) remain disabled.
- An enabled lifecycle rule expires `note-exports/` objects after **1 day**;
  incomplete multipart uploads are aborted after **7 days**. Confirm the rule
  scopes and that unrelated private media has no unintended expiration rule.
- Cloudflare bucket CORS exactly matches the four origins above and permits
  the required PUT headers. The backend will probe each origin with unsigned
  OPTIONS, redirect rejection and a five-second timeout on its direct R2 base.
- `chat/`, `notes/`, `note-exports/`, and `stickers/` continue through backend
  authorization and short-lived signed reads. Anonymous requests to the R2
  bucket and the Worker must not expose these prefixes.

After separately approved publication, verify the actual Worker URL, public
GET/HEAD, byte ranges and conditional requests. Check private-prefix and unknown
prefix denials, including query-bearing requests and after warming the public
cache. Keep the bucket private throughout. The frontend's
`EXPO_PUBLIC_MEDIA_ORIGINS` must include **both** additional origins before clients
receive R2 URLs:

- `https://windnote-media-preprod-delivery.yiboding1998.workers.dev` for public
  delivery, after confirming the actual deployed Worker URL.
- `https://0bea489023c1d8692a19dadaf15dcf95.r2.cloudflarestorage.com` for authorized
  private signed reads against the R2 S3 API.

Retain origins required by supported clients and rollback. These build-time
settings require a rebuilt app; a backend configuration change does not update
installed clients. Gate cutover on compatibility of the supported app versions
and browser builds with both public Worker and private signed R2 media.

Existing client caches can retain URLs under
`https://api-43-134-85-95.sslip.io/circle` even after database URLs are rewritten.
Require a separately reviewed delivery/proxy transition for that exact old base,
or verified continued service there, covering cached public reads and the same
private-prefix restrictions. Do not assume database rewriting redirects cached
URLs or changes that proxy. **This transition is unresolved by this preparation
work and blocks cutover until its behavior and client compatibility are verified.**

## Database URL migration preparation

Changing the canonical delivery base affects newly generated public URLs.
Historical recognition alone leaves any existing stored public URLs pointing to
their old delivery bases. No live database inventory/counts are available yet.
Prepare a separately reviewed, bounded database migration before changing those
references. Derive the inventory from
[`StorageAuditService.collectReferencedKeys`](../../src/upload/storage-audit.service.ts),
its [card query](../../src/upload/storage-audit.query.ts), and the
[Prisma schema](../../prisma/schema.prisma).

These are the mapped URL candidates to inventory, back up and dry-run:

| Shape | Prisma fields |
| --- | --- |
| Scalar | `User.avatarUrl`, `User.avatarFrame`, `User.cover`; `AvatarFrameAsset.imageUrl`; `IconAsset.imageUrl`; `AdminAdvertisement.imageUrl`; `Circle.avatarUrl`, `Circle.cover`; `ChatConversation.avatarUrl`; `NoteMedia.url`, `NoteMedia.posterUrl`; `ConsoleRelease.url` |
| Array elements | `Friend.photosA`, `Friend.photosB`, `Friend.pendingPhotosBySender`; `Trace.images`; `TraceComment.images`; `CirclePost.images` |
| Card avatar leaves | `Note.sections.contacts.items[*].faceURL` / `.avatarUrl`, `Note.sections.groups.items[*].faceURL` / `.avatarUrl`; the same four leaves under `NoteDraft.sections` |

Inventory both exact source bases:

- `https://windnote-preprod-tokyo-1447743949.cos.ap-tokyo.myqcloud.com`
- `https://api-43-134-85-95.sslip.io/circle`

For each candidate, change only a complete URL under one of those exact bases,
with a path-boundary match and one of the five public key prefixes. Remove the
entire matched base, including `/circle` for the controlled base, and preserve
the remaining key and array order when replacing it with the verified Worker
base. Do not add `/circle` or a bucket suffix to the Worker URL. A candidate
field is not automatically a public object: private
`NoteMedia` URLs, unrelated external release URLs, nulls and other unmatched
values remain unchanged. Flag malformed or query-bearing candidates for review
rather than transplanting signing parameters onto the public Worker.

Keep raw keys unchanged: `NoteDraft.mediaKeys`, `Trace.attachments[*].key` and
`.posterKey`, `CustomSticker.objectKey`, `SupportRechargePaymentCode.objectKey`,
and typed chat media keys are object references, not delivery bases. Do not run
global text replacement over `ChatMessage.content`, `contentHistory`,
`ChatBurnArchive.content`, note text / `contentJson`, or arbitrary JSON/text.
Only the listed card-avatar leaves are in scope for nested JSON changes. Include
retained/deleted note rows and pending drafts in the inventory, as the storage
audit does; do not limit the dry run to currently visible content.

The dry run must produce counts by model/field, each matched source base, public
prefix, unchanged and rejected candidates, plus the proposed changed-row count.
Either source-base count may be zero; do not infer it from deployed configuration.
Review anomalies before execution. Keep the detailed before/after mapping
(primary key, field or array/JSON position, exact previous value) in an
access-restricted, encrypted artifact outside Git and logs. Store only aggregate
results and artifact
references in the PR/change record.

Require a fresh full PostgreSQL backup and verified restore/recovery procedure
using [the existing backup runbook](../backups.md), plus a protected export of
affected scalar, array and card-avatar values. The ordinary release backup does
not replace this migration-specific backup. Apply only the reviewed mapping,
with expected-old-value checks in a transaction or bounded resumable batches;
stop on unexpected changes/counts. Verify affected-row totals and read-back
behavior before permitting writes again. Keep the mapping for targeted rollback.

## Controlled cutover checklist — pending operator work

All boxes below remain open until the operator records fresh evidence. No live
cloud, database, deployment or permanent source cleanup action is authorized by
the code-preparation PR itself.

- [ ] Review and merge a **ready-for-review** preparation PR with backend and
  Worker verification evidence. Approve the concrete Worker publication and
  cutover change separately; retain the old release and full COS configuration.
- [ ] Verify bucket privacy, lifecycle, CORS, credential scope, deployed Worker
  and both frontend-origin prerequisites above, rebuilt-client compatibility,
  and the reviewed old `/circle` delivery/proxy transition. An unresolved old
  cached-URL transition blocks this gate. Capture safe aggregate evidence.
- [ ] Run an incremental source/destination inventory and copy new/changed COS
  objects to R2, preserving keys and metadata and checking full hashes. Account
  for source deletions and export expiry explicitly; do not blindly delete R2
  objects from a stale inventory. The old 403-object checkpoint is insufficient.
- [ ] Start a controlled media-upload/write pause covering backend producers,
  exports, queued work and database fields in the mapping. Drain in-flight
  uploads and outstanding presigned PUTs (or wait for their expiry), then take
  final inventories, reconcile changes, and confirm zero unexplained drift.
  Keep the pause active through configuration and database validation.
- [ ] Complete the database dry run over both exact old bases, reviewed mapping,
  full backup and affected field export. Activate the reviewed R2 settings through
  the secure deployment flow and apply the approved URL mapping in the controlled
  window. Confirm
  backend readiness and the expected `external-unverified` storage status.
- [ ] From **each** allowed browser origin, verify OPTIONS and a real presigned
  PUT with `content-type` and `if-none-match`, followed by upload completion and
  rendering. Keep signed URLs and test object details out of shared logs. Use
  controlled test media and clean it up through the normal authorized flow.
- [ ] Verify representative historical and new public images/avatars/covers,
  arrays and frozen card avatars; exercise video ranges, editing/deletion key
  extraction and storage audit recognition. Verify authorized private chat,
  note, export and sticker reads succeed; anonymous, cross-user and unauthorized
  reads fail. Verify expiry and bucket/Worker private-prefix denials.
- [ ] Resume uploads only after the gates pass. Observe upload/read failures,
  readiness and audit aggregates, then verify a new post-resume upload. Retain
  COS objects, credentials and routing throughout the agreed rollback window.

## Rollback and later cleanup

On failed privacy, authorization, upload, readiness or rendering checks, keep or
re-enter the upload/write pause. Restore the retained COS endpoint, bucket,
region, addressing mode, public/delivery base and credentials through the secure
deployment flow, together with its prior external-verification setting. Use the
retained release artifact if required by the failure. Do not disable checks or
make R2 public to recover availability.

Before sending traffic back to COS after R2 accepted writes, reconcile every
new/changed R2 object needed by current references back to COS, with hashes and
metadata verified; account for legitimate expiry/deletion separately. Restoring
only old environment values would strand media uploaded after cutover. Restore
the backed-up URL values only where they still equal the applied migration
values; review later writes separately, including new Worker-based public URLs.
Rebase those new public references to the retained COS delivery base (including
the current controlled `/circle` base where applicable) only after their objects
exist in COS and that delivery path has been verified. Restore any separately
changed old-base proxy behavior as part of the reviewed rollback.
Retain R2/Worker recognition bases as needed for remaining historical references
and verify supported clients' origins before reopening writes. Prefer the
reviewed targeted reverse mapping; a full database restore requires an explicit
recovery decision because it can discard unrelated writes.

Re-run COS browser uploads, public rendering, private authorization and storage
audit checks, then resume writes. Keep R2 and the Worker available for any
remaining references until reconciled. Record aggregate rollback results and
protected artifact references.

Permanent COS deletion, credential revocation, legacy-base removal and Worker
retirement are later, separately reviewed cleanup changes after the retention
window, zero remaining references and successful recovery verification. This PR
prepares code and instructions only; it does not mark the live cutover complete.
