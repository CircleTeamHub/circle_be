#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL $*" >&2
  exit 1
}

# shellcheck source=../deploy/app-env-preflight.sh
. "$ROOT/deploy/app-env-preflight.sh"

compose_env="$TMP_ROOT/.env"
printf 'DB_PASSWORD=test\n' > "$compose_env"
APP_ENV_GID=99999
export APP_ENV_GID
resolved_app_env_gid=""
prepare_compose_app_env_gid "$compose_env"
expected_gid="$(id -g "$(id -un)")"
[ "$resolved_app_env_gid" = "$expected_gid" ] || fail "preflight did not select the deploy user's gid"
[ "$APP_ENV_GID" = "$expected_gid" ] || fail "preflight did not override the inherited gid"
grep -qx "APP_ENV_GID=$expected_gid" "$compose_env" || fail "preflight did not persist the gid"
echo "PASS preflight backfills and exports the validated gid"

# shellcheck source=../deploy/app-env-transaction.sh
. "$ROOT/deploy/app-env-transaction.sh"

RELEASE_STATE_DIR="$TMP_ROOT/.release"
APP_ENV_FILE="$TMP_ROOT/.env.production"
resolved_app_env_gid="$expected_gid"
SETFACL_COMMAND=true
irreversible_boundary_crossed() { return 1; }
initialize_app_env_transaction

printf 'SECRET=original\n' > "$APP_ENV_FILE"
chmod 600 "$APP_ENV_FILE"
stage_app_env_for_new_container
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=original' ] || fail "staging changed app env content"
[ -e "$APP_ENV_BACKUP_PATH" ] || fail "staging did not preserve the legacy inode"
[ -e "$APP_ENV_TRANSACTION_PATH" ] || fail "staging did not persist recovery state"
case "$APP_ENV_TRANSACTION_PATH" in
  "$RELEASE_STATE_DIR"/*) ;;
  *) fail "transaction state is outside the launcher-preserved release directory" ;;
esac
restore_legacy_app_env_access
[ -e "$APP_ENV_FILE" ] || fail "restore did not recover the legacy env"
[ ! -e "$APP_ENV_BACKUP_PATH" ] || fail "restore left the legacy backup behind"
[ ! -e "$APP_ENV_TRANSACTION_PATH" ] || fail "restore left transaction state behind"
echo "PASS reversible staging restores the exact legacy env"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=recover-me\n' > "$APP_ENV_BACKUP_PATH"
printf 'staged\n' > "$APP_ENV_TRANSACTION_PATH"
printf 'SECRET=partial\n' > "$APP_ENV_FILE"
recover_interrupted_app_env_transaction
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=recover-me' ] || fail "restart recovery did not restore the legacy env"
[ ! -e "$APP_ENV_TRANSACTION_PATH" ] || fail "restart recovery left transaction state behind"
echo "PASS restart recovery restores a staged transaction"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=orphan\n' > "$APP_ENV_BACKUP_PATH"
if recover_interrupted_app_env_transaction 2>/dev/null; then
  fail "markerless recovery state did not fail closed"
fi
echo "PASS markerless recovery state fails closed"
