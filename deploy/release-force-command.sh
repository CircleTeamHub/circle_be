#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/bin:/bin
export PATH
umask 077

fail() {
  printf 'release command rejected: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail 'server deploy root is not configured'
[[ "$1" = /* ]] || fail 'server deploy root must be absolute'
[ -d "$1" ] || fail 'server deploy root does not exist'
DEPLOY_ROOT="$(cd "$1" && pwd -P)"
RELEASE_STATE_DIR="$DEPLOY_ROOT/.release"
INCOMING_DIR="$RELEASE_STATE_DIR/incoming"
LAUNCHER="$RELEASE_STATE_DIR/release-launcher.sh"
ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}"

read -r -a command_parts <<< "$ORIGINAL_COMMAND"
[ "${#command_parts[@]}" -ge 2 ] || fail 'missing protocol command'
[ "${command_parts[0]}" = 'circle-release' ] || fail 'general SSH commands are disabled'

valid_stage_name() {
  [[ "$1" =~ ^[0-9]+-[0-9]+-[0-9a-f]{40}$ ]]
}

validate_archive() {
  local archive="$1" entry normalized mode
  while IFS= read -r entry; do
    normalized="${entry#./}"
    case "$normalized" in
      ''|.) continue ;;
      /*|../*|*/../*|*/..|.release|.release/*|.env|.env.production|.git|.git/*|node_modules|node_modules/*|dist|dist/*|logs|logs/*|coverage|coverage/*)
        fail "forbidden archive path: $entry"
        ;;
    esac
    if printf '%s' "$normalized" | LC_ALL=C grep -q '[[:cntrl:]]'; then
      fail 'archive path contains control characters'
    fi
  done < <(tar -tzf "$archive")

  while IFS= read -r mode _; do
    case "${mode:0:1}" in
      l|h) fail 'archive links are not allowed' ;;
    esac
  done < <(tar -tvzf "$archive")
}

stage_release() {
  [ "${#command_parts[@]}" -eq 4 ] || fail 'stage expects name and commit SHA'
  local stage_name="${command_parts[2]}" source_sha="${command_parts[3]}"
  valid_stage_name "$stage_name" || fail 'invalid staged release name'
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid source commit SHA'
  [ "${stage_name##*-}" = "$source_sha" ] || fail 'stage name does not match source commit SHA'

  mkdir -p "$INCOMING_DIR"
  [ ! -e "$INCOMING_DIR/$stage_name" ] || fail 'staged release already exists'
  local archive extract_dir size
  archive="$(mktemp "$RELEASE_STATE_DIR/upload.XXXXXX.tar.gz")"
  extract_dir="$(mktemp -d "$INCOMING_DIR/.extract-$stage_name.XXXXXX")"
  cleanup_stage() {
    rm -f -- "$archive"
    rm -rf -- "$extract_dir"
  }
  trap cleanup_stage EXIT

  dd bs=1048576 count=257 iflag=fullblock status=none > "$archive"
  size="$(wc -c < "$archive")"
  (( size > 0 && size <= 256 * 1024 * 1024 )) || fail 'release archive is empty or too large'
  validate_archive "$archive"
  tar -xzf "$archive" -C "$extract_dir"
  [ -f "$extract_dir/deploy/release-deploy.sh" ] || fail 'release deploy script is missing'
  [ ! -L "$extract_dir/deploy/release-deploy.sh" ] || fail 'release deploy script cannot be a link'
  printf '%s\n' "$source_sha" > "$extract_dir/.release-source-sha"
  chmod -R go-rwx "$extract_dir"
  mv -- "$extract_dir" "$INCOMING_DIR/$stage_name"
  rm -f -- "$archive"
  trap - EXIT
  printf 'staged %s\n' "$stage_name"
}

read_activation_value() {
  local variable="$1"
  IFS= read -r "$variable" || fail 'activation payload is incomplete'
}

activate_release() {
  [ "${#command_parts[@]}" -eq 3 ] || fail 'activate expects one staged release name'
  local stage_name="${command_parts[2]}"
  valid_stage_name "$stage_name" || fail 'invalid staged release name'
  local staged="$INCOMING_DIR/$stage_name"
  [ -d "$staged" ] || fail 'staged release not found'
  [ -f "$staged/.release-source-sha" ] || fail 'staged release has no source identity'
  [ "$(cat "$staged/.release-source-sha")" = "${stage_name##*-}" ] || fail 'staged release identity mismatch'
  cleanup_activation() {
    rm -rf -- "$staged"
  }
  trap cleanup_activation EXIT
  [ -f "$LAUNCHER" ] && [ -x "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] || fail 'trusted release launcher is unavailable'
  [ ! -w "$LAUNCHER" ] || fail 'trusted release launcher must not be writable by the deployment account'

  local schema tag image downtime irreversible ghcr_user ghcr_token extra
  read_activation_value schema
  read_activation_value tag
  read_activation_value image
  read_activation_value downtime
  read_activation_value irreversible
  read_activation_value ghcr_user
  read_activation_value ghcr_token
  if IFS= read -r extra; then fail 'activation payload has extra lines'; fi

  [[ "$schema" =~ ^[0-9]+$ ]] || fail 'invalid schema compatibility'
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || fail 'invalid release tag'
  [[ "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || fail 'invalid immutable image reference'
  [[ "$downtime" =~ ^[01]$ ]] || fail 'invalid downtime flag'
  [[ "$irreversible" =~ ^[01]$ ]] || fail 'invalid irreversible migration flag'
  (( ${#ghcr_user} > 0 && ${#ghcr_user} <= 100 )) || fail 'invalid registry user length'
  [[ "$ghcr_user" != *[[:space:]]* ]] || fail 'invalid registry user'
  (( ${#ghcr_token} > 0 && ${#ghcr_token} <= 4096 )) || fail 'invalid registry token length'
  [[ "$ghcr_token" =~ ^[^[:space:]]+$ ]] || fail 'invalid registry token'

  exec env -i \
    PATH=/usr/bin:/bin \
    HOME="$DEPLOY_ROOT" \
    RELEASE_STATE_DIR="$RELEASE_STATE_DIR" \
    TARGET_SCHEMA_COMPATIBILITY="$schema" \
    RELEASE_TAG="$tag" \
    CIRCLE_BE_IMAGE="$image" \
    RELEASE_DOWNTIME="$downtime" \
    RELEASE_IRREVERSIBLE_MIGRATION="$irreversible" \
    GHCR_USER="$ghcr_user" \
    GHCR_TOKEN="$ghcr_token" \
    /usr/bin/bash "$LAUNCHER" "$stage_name"
}

case "${command_parts[1]}" in
  stage) stage_release ;;
  activate) activate_release ;;
  *) fail 'unknown release protocol command' ;;
esac
