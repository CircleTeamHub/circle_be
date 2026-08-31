#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$ROOT_DIR/deploy/release-launcher.sh"
CASE_DIR="$(mktemp -d)"
DEPLOY_ROOT="$CASE_DIR/circle_be"
STATE_DIR="$DEPLOY_ROOT/.release"
START_LOG="$CASE_DIR/start.log"
trap 'rm -rf "$CASE_DIR"' EXIT

mkdir -p "$STATE_DIR/incoming/old/deploy" "$STATE_DIR/incoming/new/deploy" "$CASE_DIR/bin"
cp "$LAUNCHER" "$STATE_DIR/release-launcher.sh"
chmod +x "$STATE_DIR/release-launcher.sh"

# macOS does not provide flock; launcher ordering is asserted separately by the
# hardening test, while this deterministic regression controls the interleaving.
cat > "$CASE_DIR/bin/flock" <<'FLOCK'
#!/usr/bin/env bash
exit 0
FLOCK
chmod +x "$CASE_DIR/bin/flock"

cat > "$STATE_DIR/incoming/new/deploy/release-deploy.sh" <<'NEW_RELEASE'
#!/usr/bin/env bash
set -euo pipefail
[ "$(cat "$RELEASE_STATE_DIR/app-env-transaction/state")" = "staged" ]
[ "$(cat "$RELEASE_STATE_DIR/app-env-transaction/legacy-rollback")" = "legacy-env" ]
printf '1\n' > "$RELEASE_STATE_DIR/minimum-schema-compatibility"
printf 'new-start\n' >> "$START_LOG"
NEW_RELEASE
chmod +x "$STATE_DIR/incoming/new/deploy/release-deploy.sh"
printf '1\n' > "$STATE_DIR/incoming/new/deploy/SCHEMA_COMPATIBILITY"
printf 'new\n' > "$STATE_DIR/incoming/new/VERSION"

cat > "$STATE_DIR/incoming/old/deploy/release-deploy.sh" <<'OLD_RELEASE'
#!/usr/bin/env bash
set -euo pipefail
printf 'old-start\n' >> "$START_LOG"
OLD_RELEASE
chmod +x "$STATE_DIR/incoming/old/deploy/release-deploy.sh"
printf 'old\n' > "$STATE_DIR/incoming/old/VERSION"
printf 'initial\n' > "$DEPLOY_ROOT/VERSION"
mkdir -p "$STATE_DIR/app-env-transaction"
printf 'staged\n' > "$STATE_DIR/app-env-transaction/state"
printf 'legacy-env\n' > "$STATE_DIR/app-env-transaction/legacy-rollback"

run_launcher() {
  local stage="$1" compatibility="$2"
  PATH="$CASE_DIR/bin:$PATH" \
    TARGET_SCHEMA_COMPATIBILITY="$compatibility" \
    RELEASE_TAG=v1.2.3 \
    CIRCLE_BE_IMAGE=ghcr.io/circleteamhub/circle_be@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    RELEASE_DOWNTIME=0 \
    RELEASE_IRREVERSIBLE_MIGRATION=0 \
    GHCR_USER=test \
    GHCR_TOKEN=test \
    START_LOG="$START_LOG" \
    bash "$STATE_DIR/release-launcher.sh" "$stage"
}

# The old deployment has completed upload/preflight and is paused before the
# authoritative launcher lock. A newer irreversible release wins the lock and
# records floor 1 before the old deployment resumes.
run_launcher new 1
[ "$(cat "$STATE_DIR/minimum-schema-compatibility")" = "1" ]
[ "$(cat "$DEPLOY_ROOT/VERSION")" = "new" ]
[ "$(cat "$STATE_DIR/app-env-transaction/state")" = "staged" ]
[ "$(cat "$STATE_DIR/app-env-transaction/legacy-rollback")" = "legacy-env" ]

if run_launcher old 0 >"$CASE_DIR/old.log" 2>&1; then
  echo "old deployment unexpectedly activated" >&2
  exit 1
fi

grep -q 'schema compatibility 0 is below server minimum 1' "$CASE_DIR/old.log"
[ "$(cat "$DEPLOY_ROOT/VERSION")" = "new" ]
[ "$(cat "$START_LOG")" = "new-start" ]
echo "PASS old staged release is rejected after concurrent floor raise"
