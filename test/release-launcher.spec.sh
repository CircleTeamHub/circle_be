#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$ROOT_DIR/deploy/release-launcher.sh"
CASE_DIR="$(mktemp -d)"
DEPLOY_ROOT="$CASE_DIR/circle_be"
STATE_DIR="$DEPLOY_ROOT/.release"
START_LOG="$CASE_DIR/start.log"
trap 'rm -rf "$CASE_DIR"' EXIT

mkdir -p "$STATE_DIR/incoming/old/deploy" "$STATE_DIR/incoming/new/deploy" \
  "$STATE_DIR/incoming/runtime-old/deploy" \
  "$STATE_DIR/incoming/pre-contract/deploy" "$CASE_DIR/bin"
cp "$LAUNCHER" "$STATE_DIR/release-launcher.sh"
chmod +x "$STATE_DIR/release-launcher.sh"
[ "$(bash "$STATE_DIR/release-launcher.sh" --contract-version)" = "1" ]

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
printf 'keeps-host-config=%s\n' "${RELEASE_LAUNCHER_KEEPS_HOST_CONFIG:-}" > "$(dirname "$START_LOG")/new-env.log"
NEW_RELEASE
chmod +x "$STATE_DIR/incoming/new/deploy/release-deploy.sh"
printf '1\n' > "$STATE_DIR/incoming/new/deploy/SCHEMA_COMPATIBILITY"
printf '1\n' > "$STATE_DIR/incoming/new/deploy/RELEASE_RUNTIME_COMPATIBILITY"
printf 'new\n' > "$STATE_DIR/incoming/new/VERSION"

cat > "$STATE_DIR/incoming/old/deploy/release-deploy.sh" <<'OLD_RELEASE'
#!/usr/bin/env bash
set -euo pipefail
printf 'old-start\n' >> "$START_LOG"
OLD_RELEASE
chmod +x "$STATE_DIR/incoming/old/deploy/release-deploy.sh"
printf 'old\n' > "$STATE_DIR/incoming/old/VERSION"

cp "$STATE_DIR/incoming/old/deploy/release-deploy.sh" \
  "$STATE_DIR/incoming/runtime-old/deploy/release-deploy.sh"
printf '1\n' > "$STATE_DIR/incoming/runtime-old/deploy/SCHEMA_COMPATIBILITY"
printf 'runtime-old\n' > "$STATE_DIR/incoming/runtime-old/VERSION"
cp "$STATE_DIR/incoming/old/deploy/release-deploy.sh" \
  "$STATE_DIR/incoming/pre-contract/deploy/release-deploy.sh"
printf 'pre-contract\n' > "$STATE_DIR/incoming/pre-contract/VERSION"
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

# A freshly upgraded root-owned launcher may run while both the active tree and
# a previously staged historical release predate runtime metadata. Its own
# minimum must reject the stage before rsync mutates the live checkout.
if run_launcher pre-contract 0 >"$CASE_DIR/pre-contract.log" 2>&1; then
  echo "pre-contract deployment unexpectedly activated" >&2
  exit 1
fi
grep -q 'Staged runtime compatibility 0 is below required runtime contract 1' \
  "$CASE_DIR/pre-contract.log"
[ "$(cat "$DEPLOY_ROOT/VERSION")" = "initial" ]
[ ! -e "$START_LOG" ]

# Host-local configuration that no release carries (each directory's
# .gitignore). --delete must leave it alone, while tracked templates update.
host_local_files=(
  .env
  .env.production
  .env.backup
  monitoring/.env
  monitoring/.env.exporters
  monitoring/alertmanager/discord.url
  monitoring/alertmanager/heartbeat.url
  monitoring/alertmanager/heartbeat-fail.url
  monitoring/prometheus/metrics_token
  monitoring/prometheus/probe-targets/public.yml
)
for file in "${host_local_files[@]}"; do
  mkdir -p "$DEPLOY_ROOT/$(dirname "$file")"
  printf 'host:%s\n' "$file" > "$DEPLOY_ROOT/$file"
  chmod 600 "$DEPLOY_ROOT/$file"
done
printf 'stale\n' > "$DEPLOY_ROOT/.env.backup.example"
printf 'gone\n' > "$DEPLOY_ROOT/removed-from-release.txt"
new_stage="$STATE_DIR/incoming/new"
mkdir -p "$new_stage/monitoring/prometheus/probe-targets" "$new_stage/monitoring/alertmanager"
printf 'template\n' > "$new_stage/.env.backup.example"
printf 'template\n' > "$new_stage/monitoring/prometheus/probe-targets/public.yml.example"
printf 'template\n' > "$new_stage/monitoring/alertmanager/discord.url.example"
printf 'groups: []\n' > "$new_stage/monitoring/prometheus/alerts.yml"
# What the force command leaves behind (chmod -R go-rwx on the staged tree).
chmod -R go-rwx "$new_stage"

# The old deployment has completed upload/preflight and is paused before the
# authoritative launcher lock. A newer irreversible release wins the lock and
# records floor 1 before the old deployment resumes.
run_launcher new 1
[ "$(cat "$STATE_DIR/minimum-schema-compatibility")" = "1" ]
[ "$(cat "$DEPLOY_ROOT/VERSION")" = "new" ]
for file in "${host_local_files[@]}"; do
  [ "$(cat "$DEPLOY_ROOT/$file")" = "host:$file" ] || {
    echo "release rsync removed or replaced host-local $file" >&2
    exit 1
  }
done
[ "$(cat "$DEPLOY_ROOT/.env.backup.example")" = "template" ]
[ -f "$DEPLOY_ROOT/monitoring/prometheus/probe-targets/public.yml.example" ]
[ ! -e "$DEPLOY_ROOT/removed-from-release.txt" ]
# deploy/sync-ops-stacks.sh recreates the ops stacks only behind this marker.
grep -qx 'keeps-host-config=1' "$CASE_DIR/new-env.log"
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
# The tree root stays private: containers get their mounts through the daemon,
# and host-local secrets made with a default umask must not be reachable.
[ "$(mode_of "$DEPLOY_ROOT")" = "700" ] || { echo "release tree root is $(mode_of "$DEPLOY_ROOT"), not 700" >&2; exit 1; }
if rsync --version 2>/dev/null | head -1 | grep -qi openrsync; then
  # macOS ships openrsync, which accepts --chmod and ignores it. The server
  # and CI run GNU rsync.
  echo "SKIP release tree modes: openrsync ignores --chmod"
else
  # The monitoring containers run as their own users and bind-mount their
  # configuration from this tree.
  [ "$(mode_of "$DEPLOY_ROOT/monitoring/prometheus/alerts.yml")" = "644" ]
  [ "$(mode_of "$DEPLOY_ROOT/monitoring/prometheus")" = "755" ]
  [ "$(mode_of "$DEPLOY_ROOT/deploy/release-deploy.sh")" = "755" ]
  # Excluded secrets keep the mode the operator gave them.
  [ "$(mode_of "$DEPLOY_ROOT/.env.backup")" = "600" ]
  [ "$(mode_of "$DEPLOY_ROOT/monitoring/prometheus/metrics_token")" = "600" ]
fi
[ "$(cat "$STATE_DIR/app-env-transaction/state")" = "staged" ]
[ "$(cat "$STATE_DIR/app-env-transaction/legacy-rollback")" = "legacy-env" ]

if run_launcher runtime-old 1 >"$CASE_DIR/runtime-old.log" 2>&1; then
  echo "runtime-incompatible deployment unexpectedly activated" >&2
  exit 1
fi

grep -q 'Staged runtime compatibility 0 is below required runtime contract 1' \
  "$CASE_DIR/runtime-old.log"
[ "$(cat "$DEPLOY_ROOT/VERSION")" = "new" ]
[ "$(cat "$START_LOG")" = "new-start" ]

if run_launcher old 0 >"$CASE_DIR/old.log" 2>&1; then
  echo "old deployment unexpectedly activated" >&2
  exit 1
fi

grep -q 'schema compatibility 0 is below server minimum 1' "$CASE_DIR/old.log"
[ "$(cat "$DEPLOY_ROOT/VERSION")" = "new" ]
[ "$(cat "$START_LOG")" = "new-start" ]
echo "PASS old staged release is rejected after concurrent floor raise"
