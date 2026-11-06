# Public media delivery

This Worker reads `windnote-media-preprod` through an R2 binding and serves only
`avatars/`, `covers/`, `posts/`, `friends/`, and `uploads/` with GET and HEAD.
It denies all other prefixes before touching the cache or bucket. The R2 bucket
itself stays private; chat, notes, exports, and stickers use authorized backend
presigned reads instead of this endpoint.

Responses stream directly from R2, preserve HTTP metadata, support ETag
revalidation and video byte ranges, and cache complete cacheable image responses
up to 8 MiB. Video and larger bodies stream without cloning for the edge cache,
avoiding tee buffers when a mobile client reads more slowly than the cache writer.
The default cache lifetime is one hour; explicit private/no-store/no-cache object
metadata prevents edge caching. Query strings are excluded from cache keys.
An IP-based binding limits reads to 200 requests per ten seconds per Cloudflare
location. Runtime error events contain no object keys, URLs, credentials, or IPs;
automatic invocation URL logs are disabled.

## Verify

Use Node 22 or later:

```sh
npm ci --ignore-scripts
npm run types -- --check
npm test
npm run typecheck
npm run check
```

Tests include an isolated local R2/Workers runtime using fixture objects; they do
not require a Cloudflare token or contact the real media bucket. The runtime is
disposed after the tests. `npm run check` bundles with Wrangler's dry-run mode and
does not publish a Worker or provision bindings.

Run `npm run types` after changing bindings and commit the generated Env file.

## Publish and validate

Review the exact public-prefix scope before publishing. The configured resource
is `windnote-media-preprod-delivery` in the existing account and workers.dev
namespace, with only the media R2 binding and a rate-limit binding. Publishing or
adding the real R2 binding is a separate operator action, not part of CI.

The expected preproduction endpoint is
`https://windnote-media-preprod-delivery.yiboding1998.workers.dev`.
Confirm the actual Cloudflare deployment URL before setting the backend's
`OBJECT_STORAGE_DELIVERY_URL`. Use the S3 API endpoint, not this Worker, for
`MINIO_ENDPOINT` and `MINIO_PUBLIC_URL` so authorized private reads and uploads
remain signed against R2.

Before App cutover, verify a known public object, its HEAD and Range responses,
and a private-prefix 403. Keep the R2 development URL and whole-bucket public
access disabled. See the backend R2 cutover runbook for lifecycle attestation,
historical URL migration, incremental copy, and rollback requirements.
