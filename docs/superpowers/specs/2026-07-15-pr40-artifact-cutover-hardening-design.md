# PR #40 Artifact and Cutover Hardening Design

## Context

PR #40 builds an ARM64 image on `main`, promotes that image by digest, and deploys it with a blue-green script. Two production risks remain at head `a18f0f0a3c86d112aa4151f66ab79697cc1cc88d`:

1. CI scans a separately rebuilt `circle-be:ci` image, not the ARM64 image later pushed and promoted.
2. Both app colors share the `circle-be-app` DNS alias while the standby is starting, so Caddy can send traffic to the standby before its health gate passes.

Frontend PR #57 is outside this implementation scope because its current head `d0076f76d548ad1527f095579d5a23a6ad0e3214` already contains the required tag ancestry and protected-promotion controls.

## Goals

- Scan the exact ARM64 image before any production tag for that image is pushed.
- Keep release promotion fail-closed when the scanned SHA image is unavailable.
- Route all public API traffic to one explicit active color.
- Switch Caddy only after the standby is healthy.
- Restore the previous color and proxy target on every recoverable cutover failure.
- Cover artifact ordering and cutover failure paths with deterministic automated tests.

## Non-goals

- Change application behavior, database migrations, or API contracts.
- Merge or close duplicate PRs.
- Add another registry, deployment host, or proxy.
- Enable a release when CI, image scanning, health checks, or smoke checks fail.

## Exact ARM64 Artifact Flow

`.github/workflows/build-image.yml` remains the only workflow that creates the releasable ARM64 image. It will:

1. Build `linux/arm64` once with Buildx, `push: false`, and `load: true`.
2. Tag the loaded image with both `sha-${GITHUB_SHA}` and `main` locally.
3. Run the blocking Trivy HIGH/CRITICAL scan against the local SHA tag.
4. Push the SHA tag only after the scan succeeds.
5. Push the mutable `main` convenience tag only after the immutable SHA tag succeeds.

If build, load, or scan fails, neither tag is pushed by that run. If a push is interrupted, `release.yml` still fails closed because it requires the exact `sha-<commit>` image. The existing PR CI Docker job remains useful for pre-merge feedback, but documentation and tests will distinguish that check from the production ARM64 artifact scan.

Workflow contract tests will assert that the production workflow loads rather than directly pushes the build result, invokes Trivy on the SHA tag, and places both registry pushes after the scan step.

## Deterministic Caddy Cutover

The release will use the explicit Caddy upstream behavior already implemented in local commit `d6738a820b3c4c44836d47b56d26b4c3631ddbb6`, ported onto the current PR head with test-first staging.

- `deploy/Caddyfile.admin` routes API traffic to `{$CIRCLE_BE_UPSTREAM:circle_be}:3000`; it no longer uses the shared `circle-be-app` alias.
- `deploy/release-deploy.sh` records the active service name in `.release/active-color` using an atomic temporary-file rename.
- Before a release starts, the script aligns Caddy with the recorded/running live color. If both colors run and the state file is absent or invalid, it fails closed instead of guessing.
- The standby starts and completes its container health gate while Caddy still targets the live color.
- After the standby is healthy, the script reloads Caddy with the standby service name, persists the new active color, then performs the public smoke check.
- The old color is stopped and removed only after the smoke check succeeds.
- `.github/workflows/release.yml` excludes `.release` from rsync deletion so deployment state survives source synchronization.
- Caddy resumes its autosaved active configuration after a container restart, while each subsequent release realigns it from the persisted active-color state.

## Failure Handling

- Migration or standby startup failure leaves Caddy on the old color and restores the old container in downtime mode.
- Caddy reload failure leaves the old color serving and removes the unused standby when safe.
- Active-color persistence failure reloads Caddy back to the old color before standby cleanup.
- Smoke failure ensures the old color is healthy, reloads Caddy back to it, persists the rollback state, and only then removes the standby.
- If both colors run but active-color state is unavailable, deployment stops for manual reconciliation.
- If there is no previous color, a healthy standby is not destroyed merely because state persistence or the public smoke check fails; the script exits non-zero and reports the recovery condition.

## Testing

The implementation follows red-green-refactor sequencing.

1. Extend `scripts/release-hardening.test.mjs` with failing workflow-order assertions for build, scan, and push.
2. Update `.github/workflows/build-image.yml` minimally until those assertions pass.
3. Bring in the cutover shell harness from `d6738a8` before the production script changes and verify it fails against the current shared-alias implementation.
4. Port the Caddy, Compose, workflow-exclusion, and deploy-script changes until all shell cases pass.
5. Run the release contract tests, shell failure-path tests, workflow lint, Docker Compose rendering, backend lint, unit/integration/e2e tests, build, and `git diff --check`.

The shell harness must cover at least downtime migration recovery, interrupted two-color recovery, switch-before-retirement ordering, smoke rollback, Caddy switch failure, and active-color state-write failure.

## Delivery

All changes stay on an isolated repair branch based on PR #40 head `a18f0f0`. No PR branch is pushed, merged, or closed without a separate explicit delivery step. Frontend #57 receives verification only unless its head changes and reintroduces a confirmed blocker.
