# Production Release Hardening Design

## Scope

This document defines the `circle_be` half of a coordinated hardening change with `CircleTeamHub/circle_admin_web#1`. It closes the shared release-security and routing gaps found during production review: unverified SSH host keys, mutable Action references, admin API cutover failures, permissive smoke checks, and failure paths that can leave a broken admin deployment live.

## Architecture

Caddy is the single production edge and blue-green-aware router. Under `ADMIN_DOMAIN`, `/api/*` is handled before the static-site catch-all and sent directly to `circle-be-app:3000` with the same bounded dial retry used by `API_DOMAIN`. All other admin requests continue to `admin_web:80`. The admin Nginx container therefore has no backend discovery responsibility and cannot retain a dead Docker DNS answer.

Both backend and admin deployments fail closed on SSH identity. Release workflows require a pre-provisioned `known_hosts` secret and never build one from the network being authenticated. Every Action added by the release PR is pinned to a reviewed full commit SHA.

The admin deploy script treats the incoming image as a canonical digest reference. It records the currently running image before rollout, starts the requested image, performs strict route-specific smoke checks, and automatically recreates the prior version when validation fails.

## Components

### Caddy routing

- `API_DOMAIN` keeps its existing backend reverse proxy and retry policy.
- `ADMIN_DOMAIN` adds a first-match `/api/*` handler that proxies directly to `circle-be-app:3000` with bounded dial retries.
- The fallback admin handler proxies only non-API traffic to `admin_web:80`.
- Route tests verify handler order and backend target.

### Release workflows

- `DEPLOY_KNOWN_HOSTS` is required alongside the deploy key and host.
- The `ssh-keyscan` fallback is removed from backend release paths.
- All `uses:` references added or modified by PR #40 are pinned to full commit SHAs, including build, release, cleanup, and release publishing actions.
- Existing least-privilege job permissions remain unchanged.

### Admin deployment

- Validate `ADMIN_WEB_IMAGE` as a digest reference before changing Compose state.
- Capture the prior container image reference and container identity before rollout.
- Pull failures are fatal unless the exact requested digest is already present locally.
- Require the new container to reach running state and pass strict smoke checks.
- Admin index succeeds only on `2xx` or an explicitly expected redirect; API authentication probe succeeds on the expected authenticated/unauthenticated status set but never on `404` or `5xx`.
- On failure after rollout, restore the prior image through Compose, verify it is running, and preserve logs from the failed container.

### Contract tests

- Add executable tests for Caddy route ordering, SSH fail-closed behavior, full-SHA Action references, digest-only admin deployment, strict smoke status handling, and automatic rollback commands.
- Integrate these checks into the existing CI workflow without broad unrelated refactoring.

## Failure Handling

- Missing SSH host identity: stop before creating the SSH command.
- Caddy configuration invalid: fail CI and block merge.
- Requested admin digest unavailable: leave the current container untouched.
- New admin container fails startup or smoke: recreate the previous image and return non-zero so GitHub reports failure.
- Previous image cannot be restored: emit logs and an explicit manual recovery command, then fail.

## Testing

Each configuration or script change starts with a regression test that fails on the current PR head. Tests then drive the minimum implementation. Final verification includes the full Jest suite, backend build, Bash syntax checks, workflow YAML parsing, release-contract tests, Caddy config adaptation/validation, Docker Compose merged rendering, and cross-repository verification against the paired admin configuration.

## Coordinated Rollout

1. Merge this PR first and publish/deploy the backend release so the new Caddy route and admin rollback script are present.
2. Merge `circle_admin_web#1` and allow its main image workflow to publish the merge commit.
3. Release the admin image by version tag and verify both index and API routes.
4. Exercise manual admin rollback to an existing digest-backed version and confirm no historical tag is rebuilt or overwritten.
