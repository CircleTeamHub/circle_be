# PR #40 Artifact and Cutover Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the exact releasable ARM64 image pass a blocking scan before push and make blue-green traffic switch to one explicit healthy color with deterministic rollback.

**Architecture:** `build-image.yml` will build and load one ARM64 image, scan its immutable SHA tag, then push SHA and `main` only after success. The deploy path will replace shared-alias routing with a Caddy upstream selected by atomic reload and a persisted `.release/active-color` record, using the already-tested behavior in local commit `d6738a8` as the porting source.

**Tech Stack:** GitHub Actions YAML, Docker Buildx, Trivy, Docker Compose, Caddy 2, Bash, Node.js `node:test`.

## Global Constraints

- Base every implementation change on PR #40 head `a18f0f0a3c86d112aa4151f66ab79697cc1cc88d` plus design commit `fa69709`.
- Preserve build-once promotion: `release.yml` may promote an existing SHA image but must never rebuild it.
- Do not push any image tag before the exact local ARM64 SHA image passes blocking HIGH/CRITICAL Trivy scanning.
- Caddy must continue targeting the old color until the standby health gate passes.
- A failure must exit non-zero even when automatic recovery succeeds.
- Do not modify application code, database migrations, API contracts, frontend code, or PR state.
- Use pinned full commit SHAs for every GitHub Action.

---

### Task 1: Enforce scan-before-push for the ARM64 artifact

**Files:**
- Modify: `scripts/release-hardening.test.mjs`
- Modify: `.github/workflows/build-image.yml`
- Modify: `DEPLOY.md`

**Interfaces:**
- Consumes: `steps.meta.outputs.repo`, `github.sha`, `Dockerfile.prod`.
- Produces: scanned registry tags `${repo}:sha-${github.sha}` and `${repo}:main`; the SHA tag remains the only release input.

- [ ] **Step 1: Add the failing workflow contract test**

Append this test to `scripts/release-hardening.test.mjs`:

```js
test('releasable ARM64 image is scanned before either registry push', () => {
  const workflow = read('.github/workflows/build-image.yml');
  const build = workflow.indexOf('- name: Build and load ARM64 image');
  const scan = workflow.indexOf('- name: Scan releasable ARM64 image');
  const push = workflow.indexOf('- name: Push scanned image tags');

  assert.match(workflow, /platforms: linux\/arm64/);
  assert.match(workflow, /push: false/);
  assert.match(workflow, /load: true/);
  assert.match(
    workflow,
    /aquasecurity\/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8/,
  );
  assert.match(workflow, /image-ref: \$\{\{ steps\.meta\.outputs\.repo \}\}:sha-\$\{\{ github\.sha \}\}/);
  assert.ok(build >= 0 && build < scan, 'the ARM64 image must be built before scanning');
  assert.ok(scan < push, 'the blocking scan must finish before registry pushes');
  assert.match(workflow.slice(push), /docker push "\$SHA_IMAGE"/);
  assert.match(workflow.slice(push), /docker push "\$MAIN_IMAGE"/);
});
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```powershell
node --test scripts/release-hardening.test.mjs
```

Expected: FAIL because the current workflow has no `Build and load ARM64 image` or Trivy step and still sets `push: true`.

- [ ] **Step 3: Change the production image workflow minimally**

Replace the current `Build and push` step in `.github/workflows/build-image.yml` with:

```yaml
      - name: Build and load ARM64 image
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6
        with:
          context: .
          file: Dockerfile.prod
          platforms: linux/arm64
          push: false
          load: true
          tags: |
            ${{ steps.meta.outputs.repo }}:sha-${{ github.sha }}
            ${{ steps.meta.outputs.repo }}:main
          labels: |
            org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
          provenance: false
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Scan releasable ARM64 image
        uses: aquasecurity/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8 # v0.36.0
        with:
          image-ref: ${{ steps.meta.outputs.repo }}:sha-${{ github.sha }}
          scanners: vuln
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          trivyignores: .trivyignore
          exit-code: "1"

      - name: Push scanned image tags
        env:
          SHA_IMAGE: ${{ steps.meta.outputs.repo }}:sha-${{ github.sha }}
          MAIN_IMAGE: ${{ steps.meta.outputs.repo }}:main
        run: |
          set -euo pipefail
          docker push "$SHA_IMAGE"
          docker push "$MAIN_IMAGE"
```

Update the workflow header and `DEPLOY.md` section 6 to state that the releasable ARM64 image itself is scanned before either registry tag is pushed; keep the separate PR CI image scan described as pre-merge feedback.

- [ ] **Step 4: Run the contract test and confirm GREEN**

Run:

```powershell
node --test scripts/release-hardening.test.mjs
```

Expected: every release contract test passes.

- [ ] **Step 5: Commit the artifact fix**

```powershell
git add .github/workflows/build-image.yml scripts/release-hardening.test.mjs DEPLOY.md
git commit -m "fix(release): scan ARM64 image before push"
```

---

### Task 2: Establish failing cutover recovery tests

**Files:**
- Create: `test/release-deploy.spec.sh`
- Modify: `scripts/release-hardening.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `deploy/release-deploy.sh`, stubbed `docker`, `curl`, `flock`, `sleep`, `sed`, and `mv` commands.
- Produces: a six-case Bash regression harness with exit status 0 only when every recovery contract passes.

- [ ] **Step 1: Add the exact shell harness without production changes**

Use `git show d6738a820b3c4c44836d47b56d26b4c3631ddbb6:test/release-deploy.spec.sh` as the exact source body and add that body as `test/release-deploy.spec.sh` with `apply_patch`. It defines these concrete tests:

```text
test_migration_failure_restores_downtime_live_color
test_interrupted_rollout_preserves_recorded_live_color
test_proxy_switch_precedes_old_color_retirement
test_smoke_failure_restores_proxy_before_removing_standby
test_downtime_switch_failure_restores_previous_color_first
test_state_write_failure_rolls_proxy_back_before_cleanup
```

The harness uses `RELEASE_STATE_DIR`, `TEST_STATE_DIR`, and `TEST_COMMAND_LOG`; it must remain byte-for-byte equivalent to the source commit except for line-ending normalization.

- [ ] **Step 2: Add static contracts and CI invocation**

Extend `scripts/release-hardening.test.mjs` with:

```js
test('release selection and active-color state fail closed', () => {
  const release = read('.github/workflows/release.yml');
  const deploy = read('deploy/release-deploy.sh');
  const compose = read('docker-compose.prod.yml');

  assert.match(release, /head_sha=\$SHA&event=push&branch=main&status=completed/);
  assert.match(release, /--exclude=\/\.release/);
  assert.match(deploy, /recorded_live_color\(\)/);
  assert.match(deploy, /Refusing to guess which container is live/);
  assert.match(deploy, /caddy reload --config \/etc\/caddy\/Caddyfile/);
  assert.match(compose, /exec caddy run --resume/);
});
```

Change the `Verify release contracts` CI step to:

```yaml
      - name: Verify release contracts
        run: |
          node --test scripts/release-hardening.test.mjs
          bash test/release-deploy.spec.sh
```

- [ ] **Step 3: Run both suites and confirm RED for the intended reasons**

Run:

```powershell
node --test scripts/release-hardening.test.mjs
& 'C:\Program Files\Git\bin\bash.exe' test/release-deploy.spec.sh
```

Expected: the Node contract fails on missing active-color/Caddy reload behavior, and the shell suite fails the interrupted rollout, switch ordering, smoke rollback, reload failure, and state-write failure cases. The existing downtime migration recovery case may already pass.

- [ ] **Step 4: Commit tests only**

```powershell
git add .github/workflows/ci.yml scripts/release-hardening.test.mjs test/release-deploy.spec.sh
git commit -m "test(release): cover recoverable blue-green cutover"
```

---

### Task 3: Implement explicit Caddy cutover and rollback

**Files:**
- Modify: `deploy/Caddyfile.admin`
- Modify: `deploy/release-deploy.sh`
- Modify: `docker-compose.prod.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `docker-compose.release.yml`
- Modify: `DEPLOY.md`

**Interfaces:**
- Consumes: service names `circle_be` and `circle_be_green`, Caddy admin reload, `.release/active-color`.
- Produces: `recorded_live_color`, `persist_active_color`, `switch_proxy`, and `ensure_live` shell functions; one explicitly selected Caddy upstream.

- [ ] **Step 1: Port the reviewed production behavior from the existing commit**

Use `git show d6738a820b3c4c44836d47b56d26b4c3631ddbb6 -- deploy/Caddyfile.admin deploy/release-deploy.sh docker-compose.prod.yml .github/workflows/release.yml` as the exact reviewed diff source. Apply those hunks with `apply_patch`, preserving these concrete contracts:

```caddyfile
reverse_proxy {$CIRCLE_BE_UPSTREAM:circle_be}:3000
```

```bash
RELEASE_STATE_DIR="${RELEASE_STATE_DIR:-.release}"

recorded_live_color() {
  cat "$RELEASE_STATE_DIR/active-color" 2>/dev/null || true
}

persist_active_color() {
  local color="$1" temp
  mkdir -p "$RELEASE_STATE_DIR"
  temp="$RELEASE_STATE_DIR/active-color.tmp.$$"
  printf '%s\n' "$color" > "$temp"
  mv -f "$temp" "$RELEASE_STATE_DIR/active-color"
}

switch_proxy() {
  local target="$1"
  if [ -z "$(running caddy)" ]; then
    echo "Caddy is not running; refusing to change the active app color." >&2
    return 1
  fi
  compose exec -T -e "CIRCLE_BE_UPSTREAM=$target" caddy \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}
```

The release workflow must query only successful `push` runs on `main`:

```bash
repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$SHA&event=push&branch=main&status=completed&per_page=1
```

The rsync exclusions must include:

```yaml
--exclude=/.release
```

The Caddy service must start with autosave recovery:

```yaml
    entrypoint: ['/bin/sh', '-ec']
    command:
      - |
        if [ -s /config/caddy/autosave.json ]; then
          exec caddy run --resume
        fi
        exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

- [ ] **Step 2: Remove stale shared-alias claims from deployment documentation**

Update `docker-compose.prod.yml`, `docker-compose.release.yml`, and `DEPLOY.md` so they no longer claim Caddy routes through `circle-be-app`. Document the actual order:

```text
start standby -> wait healthy -> reload Caddy to standby -> persist active color -> public smoke -> stop/remove old color
```

Keep compatibility aliases only where an explicit legacy consumer still requires them; they must not appear as the Caddy upstream.

- [ ] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
node --test scripts/release-hardening.test.mjs
& 'C:\Program Files\Git\bin\bash.exe' test/release-deploy.spec.sh
```

Expected: all Node contract tests and all six shell failure-path cases pass.

- [ ] **Step 4: Run shell syntax and Compose rendering**

Run:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -n deploy/release-deploy.sh
& 'C:\Program Files\Git\bin\bash.exe' -n deploy/admin-web-deploy.sh
$env:DB_PASSWORD='test'; $env:MINIO_ROOT_USER='test'; $env:MINIO_ROOT_PASSWORD='test-password'; $env:API_DOMAIN='api.example.test'; $env:ADMIN_DOMAIN='admin.example.test'; $env:ACME_EMAIL='ops@example.test'; $env:CIRCLE_BE_IMAGE='ghcr.io/circleteamhub/circle_be@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; docker compose -f docker-compose.prod.yml -f docker-compose.release.yml config --quiet
```

Expected: both syntax checks and Compose rendering exit 0.

- [ ] **Step 5: Commit the cutover implementation**

```powershell
git add .github/workflows/release.yml deploy/Caddyfile.admin deploy/release-deploy.sh docker-compose.prod.yml docker-compose.release.yml DEPLOY.md
git commit -m "fix(release): switch Caddy after standby health"
```

---

### Task 4: Full regression verification and frontend recheck

**Files:**
- Verify only: backend repository working tree
- Verify only: frontend PR #57 head `d0076f76d548ad1527f095579d5a23a6ad0e3214`

**Interfaces:**
- Consumes: all backend release changes and existing project test scripts.
- Produces: fresh command evidence and a clean local commit series; no remote mutation.

- [ ] **Step 1: Run backend release-focused verification**

```powershell
node --test scripts/release-hardening.test.mjs
& 'C:\Program Files\Git\bin\bash.exe' test/release-deploy.spec.sh
git diff --check origin/pr/40...HEAD
```

Expected: zero failures and no whitespace errors.

- [ ] **Step 2: Run backend repository verification**

```powershell
npm ci
npm run lint
npm test -- --runInBand
npm run build
```

Expected: install, lint, full unit test suite, and production build all exit 0. If Docker services are available, additionally run `npm run test:redis`, `npm run test:redis:compose`, `npm run test:minio`, and `npm run test:e2e` with their documented service prerequisites.

- [ ] **Step 3: Reverify current frontend #57 instead of changing it**

From an isolated checkout of `d0076f76d548ad1527f095579d5a23a6ad0e3214`, run:

```powershell
npm ci
npm run ci
git diff --check 4cedde60b6a3f0dbb7fa8a99ff30670efd9519ff...d0076f76d548ad1527f095579d5a23a6ad0e3214
```

Confirm `.github/workflows/android-release.yml` still contains `fetch-depth: 0`, `git merge-base --is-ancestor HEAD origin/main`, `environment: android-release-publish`, and the default-disabled `ANDROID_PUBLIC_RELEASE_ENABLED` gate.

- [ ] **Step 4: Inspect final scope and history**

```powershell
git status --short --branch
git log --oneline origin/pr/40..HEAD
git diff --stat origin/pr/40...HEAD
```

Expected: only the design, plan, ARM64 artifact flow, cutover tests/implementation, and aligned documentation differ from PR #40. Do not push or merge during this task.
