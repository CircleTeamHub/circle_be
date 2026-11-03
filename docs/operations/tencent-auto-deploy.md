# Tencent x86 server automatic releases

The existing `Build Image` → `Auto Release` → `Release` workflows are the deployment path. Set `RELEASE_PLATFORM=linux/amd64` for an x86 Tencent instance. Build Image scans the exact image before publishing it; Release promotes that immutable image, backs up PostgreSQL, migrates, starts the standby backend, validates Caddy, checks the public API, and switches traffic with rollback on failure.

## One-time configuration

Follow [release-channel hardening](../release-hardening-runbook.md) to install the root-owned ForceCommand and launcher and add a dedicated restricted deployment key. Keep an independent administrator login. The server holds only the release signing public key; GitHub stores the private signing and SSH keys as encrypted Actions secrets.

Set repository variables `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `RELEASE_PLATFORM`, and `API_SMOKE_URL`. The smoke URL must be an existing unauthenticated API route that returns 401/403 JSON, such as `/api/v1/auth/me`. Keep `AUTO_RELEASE=off` while preparing the server, credentials, and database baseline.

Configure the exact database-contract approval in [migration approval](migration-approval.md), using `AUTO_RELEASE_MIGRATIONS_SHA256` and the protected server approval file. Ordinary code-only updates then deploy automatically; any migration, Prisma schema, schema compatibility, or irreversible-marker change requires a fresh manual review.

## Preserve host-specific proxy configuration

The signed launcher intentionally replaces tracked source with `rsync --delete`. Keep custom COS routes and machine-specific Compose overrides inside `.release`, which the launcher excludes from synchronization. Keep credentials in the existing excluded `.env` and `.env.production` files.

For a host-specific Caddyfile, add this non-secret entry to the server's `.env`:

```dotenv
CADDY_CONFIG_PATH=./.release/Caddyfile.cos-preprod
```

The production Compose file uses this path for the read-only `/etc/caddy/Caddyfile` mount; omitting it retains the repository's standard Caddyfile. Back up and validate an existing custom Caddyfile before changing the mount. Recreate only Caddy, with `--no-deps`, when adopting that persistent path. Backend releases do not recreate Caddy or the frontend containers.

If the deployment already exposes a direct backend port such as 3000, it must follow the active blue/green backend rather than one color. A host-local Caddyfile can preserve that existing endpoint with:

```caddyfile
http://:3000 {
    reverse_proxy {$CIRCLE_BE_UPSTREAM:circle-be-blue:3000}
}
```

Put its port mapping in a host-local Compose override under `.release`. Transfer the existing port from the old backend only after the first successful release frees it. Existing administrator and temporary-chat frontend mappings should be retained in that same host-local override. Do not expose a new public listener without an explicit requirement.

## Activation and verification

1. Verify the dedicated key returns `release-gate=1 launcher-runtime=1` for `circle-release capabilities`, and rejects an ordinary shell command.
2. Verify installed gate/launcher files are root-owned and not writable by the deployment user, and verify the approved database-contract digest on both sides.
3. Merge the reviewed workflow changes. Require CI and the platform-specific image scan/build to pass.
4. Enable automatic releases and verify a main-triggered run reaches the server, the active image's `CIRCLE_BUILD_COMMIT` equals main, `/readyz` succeeds internally, and the public health/auth probes succeed.
5. Check that Caddy retains its active color across restart, existing frontend/storage routes still work, and temporary build/check processes have exited.

Future main updates use the same checked pipeline. A failed build or health check must not become a successful deployment; inspect the linked Actions job before retrying.
