#!/usr/bin/env bash
# Persistent server-side release gate. The workflow installs this under
# .release, which rsync never replaces, and uploads target trees to
# .release/incoming before invoking it.
set -euo pipefail

RELEASE_STATE_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ROOT="$(cd "$RELEASE_STATE_DIR/.." && pwd)"
MINIMUM_SCHEMA_COMPATIBILITY_PATH="$RELEASE_STATE_DIR/minimum-schema-compatibility"
RUNTIME_COMPATIBILITY_FILE="deploy/RELEASE_RUNTIME_COMPATIBILITY"
MINIMUM_RELEASE_RUNTIME_COMPATIBILITY=1
STAGED_RELEASE_NAME="${1:-}"

if [ "$STAGED_RELEASE_NAME" = "--contract-version" ]; then
  printf '%s\n' "$MINIMUM_RELEASE_RUNTIME_COMPATIBILITY"
  exit 0
fi

if [[ ! "$STAGED_RELEASE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid staged release name: $STAGED_RELEASE_NAME" >&2
  exit 1
fi

STAGED_RELEASE="$RELEASE_STATE_DIR/incoming/$STAGED_RELEASE_NAME"
if [ ! -d "$STAGED_RELEASE" ]; then
  echo "Staged release not found: $STAGED_RELEASE" >&2
  exit 1
fi

cleanup() {
  rm -rf "$STAGED_RELEASE"
}
trap cleanup EXIT

exec 201>"$RELEASE_STATE_DIR/deploy.lock"
flock -x 201

# This is the authoritative check. It deliberately happens after the lock so
# a staged old release cannot race an irreversible rollout that raises floor.
minimum_schema_compatibility=0
if [ -e "$MINIMUM_SCHEMA_COMPATIBILITY_PATH" ]; then
  minimum_schema_compatibility="$(cat "$MINIMUM_SCHEMA_COMPATIBILITY_PATH")"
  if [[ ! "$minimum_schema_compatibility" =~ ^[0-9]+$ ]]; then
    echo "Invalid server schema boundary: $MINIMUM_SCHEMA_COMPATIBILITY_PATH" >&2
    exit 1
  fi
fi

staged_schema_compatibility=0
if [ -e "$STAGED_RELEASE/deploy/SCHEMA_COMPATIBILITY" ]; then
  staged_schema_compatibility="$(cat "$STAGED_RELEASE/deploy/SCHEMA_COMPATIBILITY")"
  if [[ ! "$staged_schema_compatibility" =~ ^[0-9]+$ ]]; then
    echo "Invalid staged schema compatibility" >&2
    exit 1
  fi
fi

if [[ ! "${TARGET_SCHEMA_COMPATIBILITY:-}" =~ ^[0-9]+$ ]]; then
  echo "Invalid target schema compatibility: ${TARGET_SCHEMA_COMPATIBILITY:-}" >&2
  exit 1
fi
if (( TARGET_SCHEMA_COMPATIBILITY != staged_schema_compatibility )); then
  echo "Target schema compatibility $TARGET_SCHEMA_COMPATIBILITY does not match staged compatibility $staged_schema_compatibility." >&2
  exit 1
fi
if (( TARGET_SCHEMA_COMPATIBILITY < minimum_schema_compatibility )); then
  echo "Target schema compatibility $TARGET_SCHEMA_COMPATIBILITY is below server minimum $minimum_schema_compatibility; restore and verify the database before explicitly clearing $MINIMUM_SCHEMA_COMPATIBILITY_PATH." >&2
  exit 1
fi

# Runtime contracts (Compose health checks, proxy routes, mounted entrypoints)
# are independent of database schema. Compare the staged application against
# the currently active tree before rsync so an incompatible rollback cannot
# partially replace live source and only then discover that it is unsafe.
live_runtime_compatibility=0
staged_runtime_compatibility=0
if [ -e "$DEPLOY_ROOT/$RUNTIME_COMPATIBILITY_FILE" ]; then
  live_runtime_compatibility="$(cat "$DEPLOY_ROOT/$RUNTIME_COMPATIBILITY_FILE")"
fi
if [ -e "$STAGED_RELEASE/$RUNTIME_COMPATIBILITY_FILE" ]; then
  staged_runtime_compatibility="$(cat "$STAGED_RELEASE/$RUNTIME_COMPATIBILITY_FILE")"
fi
if [[ ! "$live_runtime_compatibility" =~ ^[0-9]+$ ]] ||
  [[ ! "$staged_runtime_compatibility" =~ ^[0-9]+$ ]]; then
  echo "Invalid release runtime compatibility metadata" >&2
  exit 1
fi
required_runtime_compatibility="$MINIMUM_RELEASE_RUNTIME_COMPATIBILITY"
if (( live_runtime_compatibility > required_runtime_compatibility )); then
  required_runtime_compatibility="$live_runtime_compatibility"
fi
if (( staged_runtime_compatibility < required_runtime_compatibility )); then
  echo "Staged runtime compatibility $staged_runtime_compatibility is below required runtime contract $required_runtime_compatibility." >&2
  exit 1
fi

# Only this rsync mutates the active release tree, and the lock remains held
# until the target deployment script exits.
#
# Host-local configuration is never in a release, so --delete would remove it
# on every deploy: the app and backup credentials (.env.*), the monitoring
# stack's Grafana password and exporter connection strings, Alertmanager's
# webhook URLs, Prometheus' scrape token and public probe targets (see each
# directory's .gitignore). The tracked *.example templates still update.
#
# The force command stages releases go-rwx so nothing else on the host can read
# or swap them mid-flight. The active tree must not inherit that: the monitoring
# containers run as their own users and bind-mount their configuration from it.
# --chmod restores the 0755/0644 a checkout has; excluded files keep their own
# modes. The root itself goes back to private right after: the daemon resolves
# bind-mount sources as root, so containers never need to traverse it, and
# host-local secrets created with a default umask (monitoring/.env,
# alertmanager/*.url are 0644 so their containers can read them) stay out of
# reach of other local accounts.
rsync -a --delete \
  --chmod=Dgo+rx,Fgo+rX \
  --include=/.env.example \
  --include='/.env.*.example' \
  --exclude=/.env \
  --exclude='/.env.*' \
  --exclude=/monitoring/.env \
  --exclude=/monitoring/.env.exporters \
  --exclude='/monitoring/alertmanager/*.url' \
  --exclude=/monitoring/prometheus/metrics_token \
  --exclude='/monitoring/prometheus/probe-targets/*.yml' \
  --exclude=/.release \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=logs \
  --exclude=coverage \
  "$STAGED_RELEASE/" "$DEPLOY_ROOT/"
chmod go-rwx "$DEPLOY_ROOT"

cd "$DEPLOY_ROOT"
# deploy/sync-ops-stacks.sh only recreates the ops stacks when the tree was
# synced this way; an older launcher deleted the files above.
RELEASE_LAUNCHER_KEEPS_HOST_CONFIG=1 \
RELEASE_LAUNCHER_ACTIVE=1 \
RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
RELEASE_SCHEMA_COMPATIBILITY="$TARGET_SCHEMA_COMPATIBILITY" \
  bash deploy/release-deploy.sh
