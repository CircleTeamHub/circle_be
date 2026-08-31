#!/usr/bin/env bash
# Shared preflight for every Compose entrypoint that parses docker-compose.prod.yml.
# Legacy hosts may not have APP_ENV_GID in their persistent .env, while the base
# Compose file requires it before even `compose ps` can run.

validate_private_app_env_gid() {
  local deploy_user="$1" gid="$2" group_record members other_primary_users
  [[ "$gid" =~ ^[0-9]+$ ]] || {
    echo "APP_ENV_GID must be a numeric gid" >&2
    return 1
  }
  case " $(id -G "$deploy_user") " in
    *" $gid "*) ;;
    *) echo "APP_ENV_GID=$gid does not belong to deploy user $deploy_user" >&2; return 1 ;;
  esac
  if [ "$(uname -s)" = "Linux" ]; then
    command -v getent >/dev/null || {
      echo "getent is required to verify APP_ENV_GID privacy" >&2
      return 1
    }
    group_record="$(getent group "$gid")" || {
      echo "APP_ENV_GID=$gid does not exist in the group database" >&2
      return 1
    }
    members="${group_record##*:}"
    case "$members" in
      ""|"$deploy_user") ;;
      *) echo "APP_ENV_GID=$gid has other explicit members; refusing to share production secrets" >&2; return 1 ;;
    esac
    other_primary_users="$(getent passwd | awk -F: -v gid="$gid" -v user="$deploy_user" '$4 == gid && $1 != user { print $1 }')"
    [ -z "$other_primary_users" ] || {
      echo "APP_ENV_GID=$gid is another account's primary group; refusing to share production secrets" >&2
      return 1
    }
  fi
}

prepare_compose_app_env_gid() {
  local compose_env_file="$1" deploy_user expected_gid configured_gid
  [ -f "$compose_env_file" ] || {
    echo "Compose env file is missing: $compose_env_file" >&2
    return 1
  }
  deploy_user="$(id -un)"
  expected_gid="$(id -g "$deploy_user")"
  configured_gid="$(awk -F= '$1 == "APP_ENV_GID" { value = $2 } END { print value }' "$compose_env_file")"
  if [ -z "$configured_gid" ]; then
    configured_gid="$expected_gid"
    printf '\nAPP_ENV_GID=%s\n' "$configured_gid" >> "$compose_env_file"
    chmod 600 "$compose_env_file"
    echo "==> Added APP_ENV_GID=$configured_gid to legacy Compose env"
  fi
  validate_private_app_env_gid "$deploy_user" "$configured_gid" || return 1
  # Returned through the caller's shell because both deploy entrypoints need the
  # validated numeric value after sourcing this helper.
  # shellcheck disable=SC2034
  resolved_app_env_gid="$configured_gid"
  # Compose gives an inherited shell variable precedence over the value in
  # its .env file. Export the value we just validated so a stale or hostile
  # caller environment cannot silently replace the supplementary group.
  APP_ENV_GID="$configured_gid"
  export APP_ENV_GID
}
