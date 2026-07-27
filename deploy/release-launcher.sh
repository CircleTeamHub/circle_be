#!/usr/bin/env bash
# Persistent server-side release gate. The workflow installs this under
# .release, which rsync never replaces, and uploads target trees to
# .release/incoming before invoking it.
set -euo pipefail

RELEASE_STATE_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ROOT="$(cd "$RELEASE_STATE_DIR/.." && pwd)"
MINIMUM_SCHEMA_COMPATIBILITY_PATH="$RELEASE_STATE_DIR/minimum-schema-compatibility"
STAGED_RELEASE_NAME="${1:-}"

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

# Only this rsync mutates the active release tree, and the lock remains held
# until the target deployment script exits.
rsync -a --delete \
  --exclude=/.env \
  --exclude=/.env.production \
  --exclude=/.release \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=logs \
  --exclude=coverage \
  "$STAGED_RELEASE/" "$DEPLOY_ROOT/"

cd "$DEPLOY_ROOT"
RELEASE_LAUNCHER_ACTIVE=1 \
RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
RELEASE_SCHEMA_COMPATIBILITY="$TARGET_SCHEMA_COMPATIBILITY" \
  bash deploy/release-deploy.sh
