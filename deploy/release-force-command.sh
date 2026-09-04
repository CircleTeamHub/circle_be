#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/bin:/bin
export PATH
umask 077

fail() {
  printf 'release command rejected: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail 'server deploy root or signing public key is not configured'
[[ "$1" = /* ]] || fail 'server deploy root must be absolute'
[ -d "$1" ] || fail 'server deploy root does not exist'
DEPLOY_ROOT="$(cd "$1" && pwd -P)"
[ -f "$2" ] && [ ! -L "$2" ] || fail 'release signing public key is unavailable'
[ ! -w "$2" ] || fail 'release signing public key must not be writable by the deployment account'
SIGNING_PUBLIC_KEY="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
[ -n "${HOME:-}" ] || fail 'deployment home is unavailable'
DEPLOY_HOME="$(cd "$HOME" && pwd -P)"
RELEASE_STATE_DIR="$DEPLOY_ROOT/.release"
INCOMING_DIR="$RELEASE_STATE_DIR/incoming"
LAUNCHER="$RELEASE_STATE_DIR/release-launcher.sh"
ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND:-}"
ARCHIVE_MAX_ENTRIES=10000
ARCHIVE_MAX_EXPANDED_BYTES=$((1024 * 1024 * 1024))
ARCHIVE_MAX_FILE_BYTES=$((128 * 1024 * 1024))
ARCHIVE_CAPACITY_RESERVE_BYTES=$((256 * 1024 * 1024))
# stage 与 activate 都在同一次发布流水线内发生,一小时足够覆盖重试与人工确认,
# 又把重放窗口压到远小于"下一次发布"的尺度。
MANIFEST_MAX_AGE_SECONDS=3600
MANIFEST_MAX_CLOCK_SKEW_SECONDS=300

read -r -a command_parts <<< "$ORIGINAL_COMMAND"
[ "${#command_parts[@]}" -ge 2 ] || fail 'missing protocol command'
[ "${command_parts[0]}" = 'circle-release' ] || fail 'general SSH commands are disabled'

valid_stage_name() {
  [[ "$1" =~ ^[0-9]+-[0-9]+-[0-9a-f]{40}$ ]]
}

read_manifest() {
  local manifest="$1"
  local -a lines
  mapfile -t lines < "$manifest"
  [ "${#lines[@]}" -eq 10 ] || fail 'release manifest must contain exactly ten lines'
  [ "${lines[0]}" = 'version=2' ] || fail 'unsupported release manifest version'
  [[ "${lines[1]}" =~ ^issued_at=([0-9]{10,11})$ ]] || fail 'invalid manifest issue time'
  MANIFEST_ISSUED_AT="${BASH_REMATCH[1]}"
  [[ "${lines[2]}" =~ ^stage=([0-9]+-[0-9]+-[0-9a-f]{40})$ ]] || fail 'invalid manifest stage'
  MANIFEST_STAGE="${BASH_REMATCH[1]}"
  [[ "${lines[3]}" =~ ^source_sha=([0-9a-f]{40})$ ]] || fail 'invalid manifest source SHA'
  MANIFEST_SOURCE_SHA="${BASH_REMATCH[1]}"
  [[ "${lines[4]}" =~ ^archive_sha256=([0-9a-f]{64})$ ]] || fail 'invalid manifest archive digest'
  MANIFEST_ARCHIVE_SHA256="${BASH_REMATCH[1]}"
  [[ "${lines[5]}" =~ ^release_tag=(v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?)$ ]] || fail 'invalid manifest release tag'
  MANIFEST_RELEASE_TAG="${BASH_REMATCH[1]}"
  [[ "${lines[6]}" =~ ^image=(ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64})$ ]] || fail 'invalid manifest image'
  MANIFEST_IMAGE="${BASH_REMATCH[1]}"
  [[ "${lines[7]}" =~ ^schema=([0-9]+)$ ]] || fail 'invalid manifest schema compatibility'
  MANIFEST_SCHEMA="${BASH_REMATCH[1]}"
  [[ "${lines[8]}" =~ ^downtime=([01])$ ]] || fail 'invalid manifest downtime flag'
  MANIFEST_DOWNTIME="${BASH_REMATCH[1]}"
  [[ "${lines[9]}" =~ ^irreversible=([01])$ ]] || fail 'invalid manifest irreversible flag'
  MANIFEST_IRREVERSIBLE="${BASH_REMATCH[1]}"
  [ "${MANIFEST_STAGE##*-}" = "$MANIFEST_SOURCE_SHA" ] || fail 'manifest stage does not match source SHA'
}

verify_manifest_signature() {
  local manifest="$1" signature="$2"
  openssl dgst -sha256 -verify "$SIGNING_PUBLIC_KEY" \
    -signature "$signature" "$manifest" >/dev/null 2>&1 ||
    fail 'release manifest signature verification failed'
  read_manifest "$manifest"
}

# 签名回答的是"这份 manifest 出自 CI",不是"CI 现在要发它"。少了这一步,任何
# 一份历史上签过的 (manifest, 签名, 归档) 三元组永久有效:拿到部署密钥的人可以
# 把旧发布重新 stage 再 activate,把服务降级回任意同 schema 代的历史版本 ——
# 而这套 ForceCommand 防的就是部署密钥泄露。
assert_manifest_fresh() {
  local now skew_ahead age
  now="$(date -u +%s)"
  skew_ahead=$((MANIFEST_ISSUED_AT - now))
  (( skew_ahead <= MANIFEST_MAX_CLOCK_SKEW_SECONDS )) || fail 'release manifest is issued in the future'
  age=$((now - MANIFEST_ISSUED_AT))
  (( age <= MANIFEST_MAX_AGE_SECONDS )) || fail 'release manifest has expired'
}

validate_archive() {
  local archive="$1" scratch="$2" entry normalized mode owner size rest
  local paths="$scratch/.archive-paths" details="$scratch/.archive-details"
  local entry_count=0 detail_count=0 expanded_bytes=0
  timeout 60s tar -tzf "$archive" > "$paths" || fail 'archive listing timed out or failed'
  timeout 60s tar --numeric-owner -tvzf "$archive" > "$details" || fail 'archive detail listing timed out or failed'

  while IFS= read -r entry; do
    (( entry_count += 1 ))
    (( entry_count <= ARCHIVE_MAX_ENTRIES )) || fail 'archive contains too many entries'
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
  done < "$paths"

  while IFS=' ' read -r mode owner size rest; do
    (( detail_count += 1 ))
    case "${mode:0:1}" in
      d) ;;
      -)
        [[ "$size" =~ ^[0-9]+$ ]] || fail 'archive contains an invalid file size'
        (( size <= ARCHIVE_MAX_FILE_BYTES )) || fail 'archive file exceeds expanded size limit'
        (( expanded_bytes += size ))
        (( expanded_bytes <= ARCHIVE_MAX_EXPANDED_BYTES )) || fail 'archive exceeds total expanded size limit'
        ;;
      *) fail 'archive contains unsupported file type' ;;
    esac
  done < "$details"
  [ "$detail_count" -eq "$entry_count" ] || fail 'archive listings disagree'
  rm -f -- "$paths" "$details"
  ARCHIVE_ENTRY_COUNT="$entry_count"
  ARCHIVE_EXPANDED_BYTES="$expanded_bytes"
}

validate_extraction_capacity() {
  local archive_size="$1" available_blocks block_size available_inodes available_bytes required_bytes required_inodes
  read -r available_blocks block_size available_inodes < <(stat -f -c '%a %S %d' "$INCOMING_DIR") ||
    fail 'could not determine release filesystem capacity'
  [[ "$available_blocks" =~ ^[0-9]+$ ]] || fail 'could not determine release filesystem capacity'
  [[ "$block_size" =~ ^[0-9]+$ ]] || fail 'could not determine release filesystem block size'
  [[ "$available_inodes" =~ ^[0-9]+$ ]] || fail 'could not determine release filesystem inode capacity'
  available_bytes=$((available_blocks * block_size))
  required_bytes=$((archive_size + ARCHIVE_EXPANDED_BYTES + ARCHIVE_CAPACITY_RESERVE_BYTES))
  required_inodes=$((ARCHIVE_ENTRY_COUNT + 1000))
  (( available_bytes >= required_bytes )) || fail 'insufficient release filesystem space'
  (( available_inodes >= required_inodes )) || fail 'insufficient release filesystem inodes'
}

stage_release() {
  [ "${#command_parts[@]}" -eq 5 ] || fail 'stage-v2 expects name, manifest, and signature'
  local stage_name="${command_parts[2]}" manifest_b64="${command_parts[3]}" signature_b64="${command_parts[4]}"
  valid_stage_name "$stage_name" || fail 'invalid staged release name'
  (( ${#manifest_b64} > 0 && ${#manifest_b64} <= 4096 )) || fail 'invalid encoded release manifest length'
  (( ${#signature_b64} > 0 && ${#signature_b64} <= 4096 )) || fail 'invalid encoded release signature length'
  [[ "$manifest_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || fail 'invalid encoded release manifest'
  [[ "$signature_b64" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || fail 'invalid encoded release signature'

  mkdir -p "$RELEASE_STATE_DIR" || fail 'release state directory is unavailable'
  exec 202>"$RELEASE_STATE_DIR/deploy.lock" || fail 'release lock is unavailable'
  /usr/bin/flock -n 202 || fail 'another release operation is in progress'
  mkdir -p "$INCOMING_DIR"
  [ ! -e "$INCOMING_DIR/$stage_name" ] || fail 'staged release already exists'
  local archive extract_dir manifest signature size archive_sha
  archive="$(mktemp "$RELEASE_STATE_DIR/upload.XXXXXX.tar.gz")"
  extract_dir="$(mktemp -d "$INCOMING_DIR/.extract-$stage_name.XXXXXX")"
  manifest="$(mktemp "$RELEASE_STATE_DIR/manifest.XXXXXX")"
  signature="$(mktemp "$RELEASE_STATE_DIR/signature.XXXXXX")"
  cleanup_stage() {
    rm -f -- "$archive" "$manifest" "$signature"
    rm -rf -- "$extract_dir"
  }
  trap cleanup_stage EXIT

  printf '%s' "$manifest_b64" | base64 --decode > "$manifest" 2>/dev/null || fail 'release manifest decoding failed'
  printf '%s' "$signature_b64" | base64 --decode > "$signature" 2>/dev/null || fail 'release signature decoding failed'
  verify_manifest_signature "$manifest" "$signature"
  assert_manifest_fresh
  [ "$MANIFEST_STAGE" = "$stage_name" ] || fail 'manifest stage does not match command'

  dd bs=1048576 count=257 iflag=fullblock status=none > "$archive"
  size="$(wc -c < "$archive")"
  (( size > 0 && size <= 256 * 1024 * 1024 )) || fail 'release archive is empty or too large'
  archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
  [ "$archive_sha" = "$MANIFEST_ARCHIVE_SHA256" ] || fail 'release archive digest mismatch'
  validate_archive "$archive" "$extract_dir"
  validate_extraction_capacity "$size"
  timeout 120s tar -xzf "$archive" -C "$extract_dir" || fail 'archive extraction timed out or failed'
  [ -f "$extract_dir/deploy/release-deploy.sh" ] || fail 'release deploy script is missing'
  [ ! -L "$extract_dir/deploy/release-deploy.sh" ] || fail 'release deploy script cannot be a link'
  printf '%s\n' "$MANIFEST_SOURCE_SHA" > "$extract_dir/.release-source-sha"
  cp -- "$manifest" "$extract_dir/.release-manifest"
  cp -- "$signature" "$extract_dir/.release-manifest.sig"
  chmod -R go-rwx "$extract_dir"
  mv -- "$extract_dir" "$INCOMING_DIR/$stage_name"
  rm -f -- "$archive" "$manifest" "$signature"
  trap - EXIT
  printf 'staged %s\n' "$stage_name"
}

read_activation_value() {
  local variable="$1"
  IFS= read -r "$variable" || fail 'activation payload is incomplete'
}

activate_release() {
  [ "${#command_parts[@]}" -eq 3 ] || fail 'activate-v2 expects one staged release name'
  local stage_name="${command_parts[2]}"
  valid_stage_name "$stage_name" || fail 'invalid staged release name'
  local staged="$INCOMING_DIR/$stage_name"
  [ -d "$staged" ] || fail 'staged release not found'
  [ -f "$staged/.release-source-sha" ] || fail 'staged release has no source identity'
  [ "$(cat "$staged/.release-source-sha")" = "${stage_name##*-}" ] || fail 'staged release identity mismatch'
  [ -f "$staged/.release-manifest" ] && [ ! -L "$staged/.release-manifest" ] || fail 'staged release has no signed manifest'
  [ -f "$staged/.release-manifest.sig" ] && [ ! -L "$staged/.release-manifest.sig" ] || fail 'staged release has no manifest signature'
  verify_manifest_signature "$staged/.release-manifest" "$staged/.release-manifest.sig"
  assert_manifest_fresh
  [ "$MANIFEST_STAGE" = "$stage_name" ] || fail 'staged manifest identity mismatch'
  # 启动器缺失/可写是服务器侧的配置问题,不是这批 stage 的问题。清理钩子要装在
  # 这两道检查之后 —— 装在前面的话,一次配置错误会顺手删掉刚上传完的发布包,
  # 运维改好配置后还得让 CI 把整包重传一遍。
  [ -f "$LAUNCHER" ] && [ -x "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] || fail 'trusted release launcher is unavailable'
  [ ! -w "$LAUNCHER" ] || fail 'trusted release launcher must not be writable by the deployment account'
  cleanup_activation() {
    rm -rf -- "$staged"
  }
  trap cleanup_activation EXIT

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
  [ "$schema" = "$MANIFEST_SCHEMA" ] || fail 'activation schema does not match signed manifest'
  [ "$tag" = "$MANIFEST_RELEASE_TAG" ] || fail 'activation tag does not match signed manifest'
  [ "$image" = "$MANIFEST_IMAGE" ] || fail 'activation image does not match signed manifest'
  [ "$downtime" = "$MANIFEST_DOWNTIME" ] || fail 'activation downtime does not match signed manifest'
  [ "$irreversible" = "$MANIFEST_IRREVERSIBLE" ] || fail 'activation irreversible flag does not match signed manifest'
  (( ${#ghcr_user} > 0 && ${#ghcr_user} <= 100 )) || fail 'invalid registry user length'
  [[ "$ghcr_user" != *[[:space:]]* ]] || fail 'invalid registry user'
  (( ${#ghcr_token} > 0 && ${#ghcr_token} <= 4096 )) || fail 'invalid registry token length'
  [[ "$ghcr_token" =~ ^[^[:space:]]+$ ]] || fail 'invalid registry token'

  exec env -i \
    PATH=/usr/bin:/bin \
    HOME="$DEPLOY_HOME" \
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

release_capabilities() {
  [ "${#command_parts[@]}" -eq 2 ] || fail 'capabilities accepts no arguments'
  [ -f "$LAUNCHER" ] && [ -x "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] || fail 'trusted release launcher is unavailable'
  [ ! -w "$LAUNCHER" ] || fail 'trusted release launcher must not be writable by the deployment account'
  local launcher_contract
  launcher_contract="$("$LAUNCHER" --contract-version 2>/dev/null)" ||
    fail 'trusted release launcher predates the runtime contract'
  [ "$launcher_contract" = "1" ] || fail 'trusted release launcher has an unsupported runtime contract'
  printf 'release-gate=1 launcher-runtime=%s\n' "$launcher_contract"
}

case "${command_parts[1]}" in
  capabilities) release_capabilities ;;
  stage-v2) stage_release ;;
  activate-v2) activate_release ;;
  *) fail 'unknown release protocol command' ;;
esac
