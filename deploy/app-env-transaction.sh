#!/usr/bin/env bash
# Transactional migration of the production app env from legacy access to a
# deployment-private supplementary group. This file only defines primitives;
# callers explicitly initialize, recover, stage, commit, or restore.

initialize_app_env_transaction() {
  APP_ENV_TRANSACTION_DIR="$RELEASE_STATE_DIR/app-env-transaction"
  APP_ENV_BACKUP_PATH="$APP_ENV_TRANSACTION_DIR/legacy-rollback"
  APP_ENV_STAGED_PATH="$APP_ENV_TRANSACTION_DIR/access.tmp"
  APP_ENV_TRANSACTION_PATH="$APP_ENV_TRANSACTION_DIR/state"
  legacy_app_env_backup=""
  app_env_staged_file=""
  app_env_transaction_committed=0
  app_env_transaction_active=0
}

clear_app_env_acl() {
  local file="$1" mode setfacl_command="${SETFACL_COMMAND:-setfacl}"
  case "$(uname -s)" in
    Linux)
      if command -v "$setfacl_command" >/dev/null; then
        "$setfacl_command" -b "$file" || return 1
        if [ -d "$file" ]; then
          "$setfacl_command" -k "$file" || return 1
        fi
      else
        mode="$(LC_ALL=C ls -ld -- "$file" | awk '{ print $1 }')"
        case "$mode" in
          *+) echo "$file has an extended ACL; install the acl package before release" >&2; return 1 ;;
          *) ;;
        esac
      fi
      ;;
    Darwin) chmod -N "$file" ;;
    *) echo "cannot safely clear ACLs on $file for this operating system" >&2; return 1 ;;
  esac
}

can_rewrite_app_env_acl_safely() {
  case "$(uname -s)" in
    Linux) command -v "${SETFACL_COMMAND:-setfacl}" >/dev/null ;;
    Darwin) return 0 ;;
    *) return 1 ;;
  esac
}

persist_app_env_transaction_state() {
  local state="$1" temp="${APP_ENV_TRANSACTION_PATH}.tmp"
  mkdir -p "$APP_ENV_TRANSACTION_DIR" || return 1
  clear_app_env_acl "$APP_ENV_TRANSACTION_DIR" || return 1
  chmod 700 "$APP_ENV_TRANSACTION_DIR" || return 1
  rm -f "$temp" || return 1
  (umask 077 && printf '%s\n' "$state" > "$temp") || return 1
  mv -f "$temp" "$APP_ENV_TRANSACTION_PATH"
}

clear_app_env_transaction_state() {
  rm -f "$APP_ENV_TRANSACTION_PATH" "${APP_ENV_TRANSACTION_PATH}.tmp"
  rmdir "$APP_ENV_TRANSACTION_DIR" 2>/dev/null || true
  app_env_transaction_active=0
}

# EXIT traps cannot run after SIGKILL or a host reboot. Recover deterministic
# state before the first Compose parse. Unknown or markerless state fails closed.
recover_interrupted_app_env_transaction() {
  local state
  if [ ! -e "$APP_ENV_TRANSACTION_PATH" ]; then
    if [ -e "$APP_ENV_BACKUP_PATH" ] || [ -e "$APP_ENV_STAGED_PATH" ]; then
      echo "App env staging files exist without a transaction marker; refusing to guess recovery state" >&2
      return 1
    fi
    rm -f "${APP_ENV_TRANSACTION_PATH}.tmp"
    return 0
  fi

  state="$(cat "$APP_ENV_TRANSACTION_PATH")" || return 1
  case "$state" in
    staged|staged-irreversible)
      rm -f "$APP_ENV_STAGED_PATH"
      if [ -e "$APP_ENV_BACKUP_PATH" ]; then
        if [ "$state" = "staged-irreversible" ] && [ -e "$APP_ENV_FILE" ]; then
          rm -f "$APP_ENV_BACKUP_PATH" || return 1
          echo "==> Finalized app env access after an interrupted irreversible release" >&2
        else
          rm -f "$APP_ENV_FILE" || return 1
          mv "$APP_ENV_BACKUP_PATH" "$APP_ENV_FILE" || return 1
          echo "==> Recovered legacy app env access from an interrupted release" >&2
        fi
      fi
      clear_app_env_transaction_state
      ;;
    committed)
      rm -f "$APP_ENV_BACKUP_PATH" "$APP_ENV_STAGED_PATH"
      clear_app_env_transaction_state
      ;;
    *)
      echo "Invalid app env transaction state: $state" >&2
      return 1
      ;;
  esac
}

stage_app_env_for_new_container() {
  local transaction_state="staged"
  [ -f "$APP_ENV_FILE" ] || return 0
  [ ! -e "$APP_ENV_BACKUP_PATH" ] && [ ! -e "$APP_ENV_STAGED_PATH" ] || {
    echo "App env staging path already exists; refusing to overwrite it" >&2
    return 1
  }
  if irreversible_boundary_crossed; then
    transaction_state="staged-irreversible"
  fi
  persist_app_env_transaction_state "$transaction_state" || return 1
  app_env_transaction_active=1
  legacy_app_env_backup="$APP_ENV_BACKUP_PATH"
  app_env_staged_file="$APP_ENV_STAGED_PATH"

  if ! mv "$APP_ENV_FILE" "$legacy_app_env_backup"; then
    legacy_app_env_backup=""
    app_env_staged_file=""
    clear_app_env_transaction_state
    return 1
  fi
  if ! (umask 077 && : > "$app_env_staged_file") ||
    ! clear_app_env_acl "$app_env_staged_file" ||
    ! chmod 600 "$app_env_staged_file" ||
    ! cat "$legacy_app_env_backup" > "$app_env_staged_file" ||
    ! chgrp "$resolved_app_env_gid" "$app_env_staged_file" ||
    ! clear_app_env_acl "$app_env_staged_file" ||
    ! chmod 640 "$app_env_staged_file" ||
    ! mv "$app_env_staged_file" "$APP_ENV_FILE"; then
    rm -f "$app_env_staged_file" "$APP_ENV_FILE"
    app_env_staged_file=""
    if mv "$legacy_app_env_backup" "$APP_ENV_FILE"; then
      legacy_app_env_backup=""
      clear_app_env_transaction_state
    else
      echo "CRITICAL: original app env remains at $legacy_app_env_backup" >&2
    fi
    return 1
  fi
  app_env_staged_file=""
}

restore_legacy_app_env_access() {
  [ -n "$legacy_app_env_backup" ] && [ -e "$legacy_app_env_backup" ] || return 0
  rm -f "$APP_ENV_FILE"
  mv "$legacy_app_env_backup" "$APP_ENV_FILE" || return 1
  legacy_app_env_backup=""
  clear_app_env_transaction_state
  echo "==> Restored legacy app env access for the previous container" >&2
}

discard_legacy_app_env_backup() {
  [ -n "$legacy_app_env_backup" ] || return 0
  rm -f "$legacy_app_env_backup"
  legacy_app_env_backup=""
}

commit_app_env_transaction() {
  [ "$app_env_transaction_active" = "1" ] || return 0
  persist_app_env_transaction_state committed || return 1
  app_env_transaction_committed=1
  discard_legacy_app_env_backup || return 1
  clear_app_env_transaction_state
}
