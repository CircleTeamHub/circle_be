#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL $*" >&2
  exit 1
}

file_mode() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

file_inode() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%i' "$1"
  else
    stat -c '%i' "$1"
  fi
}

file_gid() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%g' "$1"
  else
    stat -c '%g' "$1"
  fi
}

assert_transaction_cleared() {
  [ ! -e "$APP_ENV_BACKUP_PATH" ] || fail "transaction left the legacy backup behind"
  [ ! -e "$APP_ENV_STAGED_PATH" ] || fail "transaction left the staged file behind"
  [ ! -e "$APP_ENV_TRANSACTION_PATH" ] || fail "transaction left its marker behind"
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
irreversible_boundary_crossed() { return 1; }
mkdir -p "$RELEASE_STATE_DIR"
if [ "$(uname -s)" = "Linux" ]; then
  command -v setfacl >/dev/null || fail "Linux CI must install the acl package"
  command -v getfacl >/dev/null || fail "Linux CI must install the acl package"
  setfacl -m u:nobody:r-x,d:u:nobody:r-x "$RELEASE_STATE_DIR"
fi
initialize_app_env_transaction

printf 'SECRET=original\n' > "$APP_ENV_FILE"
chmod 600 "$APP_ENV_FILE"
legacy_inode="$(file_inode "$APP_ENV_FILE")"
stage_app_env_for_new_container
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=original' ] || fail "staging changed app env content"
[ -e "$APP_ENV_BACKUP_PATH" ] || fail "staging did not preserve the legacy inode"
[ -e "$APP_ENV_TRANSACTION_PATH" ] || fail "staging did not persist recovery state"
[ "$(file_inode "$APP_ENV_BACKUP_PATH")" = "$legacy_inode" ] || fail "staging did not preserve the original inode"
[ "$(file_inode "$APP_ENV_FILE")" != "$legacy_inode" ] || fail "staging did not replace the legacy inode"
[ "$(file_mode "$APP_ENV_FILE")" = "640" ] || fail "staged app env is not mode 0640"
[ "$(file_mode "$APP_ENV_BACKUP_PATH")" = "600" ] || fail "legacy backup mode changed"
[ "$(file_gid "$APP_ENV_FILE")" = "$expected_gid" ] || fail "staged app env has the wrong gid"
if [ "$(uname -s)" = "Linux" ]; then
  if getfacl -cp "$APP_ENV_TRANSACTION_DIR" "$APP_ENV_FILE" | grep -Eq '^(default:|user:nobody:)'; then
    fail "staging retained an inherited named or default ACL"
  fi
fi
case "$APP_ENV_TRANSACTION_PATH" in
  "$RELEASE_STATE_DIR"/*) ;;
  *) fail "transaction state is outside the launcher-preserved release directory" ;;
esac
restore_legacy_app_env_access
[ -e "$APP_ENV_FILE" ] || fail "restore did not recover the legacy env"
[ "$(file_inode "$APP_ENV_FILE")" = "$legacy_inode" ] || fail "restore did not recover the original inode"
[ "$(file_mode "$APP_ENV_FILE")" = "600" ] || fail "restore did not recover the original mode"
assert_transaction_cleared
echo "PASS reversible staging restores the exact legacy env"

initialize_app_env_transaction
printf 'SECRET=commit-me\n' > "$APP_ENV_FILE"
chmod 600 "$APP_ENV_FILE"
stage_app_env_for_new_container
commit_app_env_transaction
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=commit-me' ] || fail "commit changed app env content"
[ "$(file_mode "$APP_ENV_FILE")" = "640" ] || fail "commit did not preserve group-readable access"
assert_transaction_cleared
echo "PASS commit keeps only the protected app env"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=recover-me\n' > "$APP_ENV_BACKUP_PATH"
chmod 600 "$APP_ENV_BACKUP_PATH"
recovery_inode="$(file_inode "$APP_ENV_BACKUP_PATH")"
printf 'staged\n' > "$APP_ENV_TRANSACTION_PATH"
printf 'SECRET=partial\n' > "$APP_ENV_FILE"
recover_interrupted_app_env_transaction
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=recover-me' ] || fail "restart recovery did not restore the legacy env"
[ "$(file_inode "$APP_ENV_FILE")" = "$recovery_inode" ] || fail "restart recovery did not restore the original inode"
[ "$(file_mode "$APP_ENV_FILE")" = "600" ] || fail "restart recovery did not restore the original mode"
assert_transaction_cleared
echo "PASS restart recovery restores a staged transaction"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=legacy\n' > "$APP_ENV_BACKUP_PATH"
printf 'SECRET=current\n' > "$APP_ENV_FILE"
printf 'staged-irreversible\n' > "$APP_ENV_TRANSACTION_PATH"
current_inode="$(file_inode "$APP_ENV_FILE")"
recover_interrupted_app_env_transaction
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=current' ] || fail "irreversible recovery restored obsolete secrets"
[ "$(file_inode "$APP_ENV_FILE")" = "$current_inode" ] || fail "irreversible recovery replaced the current inode"
assert_transaction_cleared
echo "PASS irreversible recovery keeps the new app env"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=obsolete\n' > "$APP_ENV_BACKUP_PATH"
printf 'SECRET=partial\n' > "$APP_ENV_STAGED_PATH"
printf 'SECRET=current\n' > "$APP_ENV_FILE"
printf 'committed\n' > "$APP_ENV_TRANSACTION_PATH"
recover_interrupted_app_env_transaction
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=current' ] || fail "committed recovery changed the live app env"
assert_transaction_cleared
echo "PASS committed recovery removes stale transaction files"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=legacy\n' > "$APP_ENV_BACKUP_PATH"
printf 'SECRET=cutover\n' > "$APP_ENV_FILE"
chmod 640 "$APP_ENV_FILE"
printf 'cutover-pending:circle_be_green:circle_be\n' > "$APP_ENV_TRANSACTION_PATH"
recover_interrupted_app_env_transaction
[ "$app_env_recovery_deferred" = "1" ] || fail "cutover recovery was not deferred"
[ "$recovered_app_env_cutover_color" = "circle_be_green" ] || fail "cutover recovery lost its target color"
[ "$recovered_app_env_previous_color" = "circle_be" ] || fail "cutover recovery lost its previous color"
[ -e "$APP_ENV_BACKUP_PATH" ] || fail "cutover recovery removed rollback state before proxy reconciliation"
[ "$(cat "$APP_ENV_FILE")" = 'SECRET=cutover' ] || fail "cutover recovery restored obsolete secrets"
commit_app_env_transaction
assert_transaction_cleared
echo "PASS cutover recovery preserves the protected env until proxy reconciliation"

initialize_app_env_transaction
mkdir -p "$APP_ENV_TRANSACTION_DIR"
printf 'SECRET=orphan\n' > "$APP_ENV_BACKUP_PATH"
if recover_interrupted_app_env_transaction 2>/dev/null; then
  fail "markerless recovery state did not fail closed"
fi
echo "PASS markerless recovery state fails closed"
