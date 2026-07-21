#!/usr/bin/env bash
# Shared helpers for the circle_be backup/restore scripts.
# Sourced, never executed directly.

set -euo pipefail

log()  { printf '%s [%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${LOG_TAG:-backup}" "$*"; }
warn() { log "WARN  $*" >&2; }
die()  { log "FATAL $*" >&2; exit 1; }

# require_env VAR... — fail fast on missing configuration.
# Every secret in this system comes from the environment. There is deliberately
# no default value for any credential: a default credential is a published
# credential (see the openIM123 defaults the upstream openim-docker stack ships).
require_env() {
  local missing=() name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("$name"); fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "missing required env: ${missing[*]} (see .env.backup.example)"
  fi
}

# Shared S3 destination settings. Used by every store's backup path.
require_backup_destination() {
  require_env BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_KEY BACKUP_S3_KEY_SECRET
  # The destination is off-host by definition, so it is always reached over the
  # public internet. pgBackRest has no plaintext option for S3 repos at all
  # (there is no scheme/http setting — repo-storage-verify-tls only controls
  # certificate checking, not whether TLS is used), and shipping backups in the
  # clear would be indefensible regardless. Require https and say why.
  case "$BACKUP_S3_ENDPOINT" in
    https://*) ;;
    http://*) die "BACKUP_S3_ENDPOINT must be https:// — pgBackRest cannot talk plaintext to an S3 repo, and off-host backups must not travel in the clear" ;;
    *) die "BACKUP_S3_ENDPOINT must start with https:// (got: $BACKUP_S3_ENDPOINT)" ;;
  esac
}

# Split "https://host[:port][/path]" into _S3_HOST / _S3_PORT.
# pgBackRest wants the bare host in repo1-s3-endpoint and the port separately in
# repo1-storage-port; leaving ":9000" glued onto the endpoint while also setting
# a port makes it dial the wrong thing and hang.
_parse_destination() {
  local rest="${BACKUP_S3_ENDPOINT#https://}"
  _S3_HOST="${rest%%/*}"
  _S3_PORT=443
  case "$_S3_HOST" in
    *:*) _S3_PORT="${_S3_HOST##*:}"; _S3_HOST="${_S3_HOST%:*}" ;;
  esac
}

# mc wrapper: adds --insecure when the destination uses a self-signed cert.
# Defined as a function named `mc` so call sites read naturally.
mc() {
  local flags=()
  [ "${BACKUP_S3_INSECURE_TLS:-}" = "1" ] && flags+=(--insecure)
  command mc "${flags[@]}" "$@"
}

# Export pgBackRest options that carry secrets as PGBACKREST_* env vars.
# pgBackRest reads any option as PGBACKREST_<OPTION_WITH_UNDERSCORES>, which
# keeps credentials out of pgbackrest.conf (that file is mounted read-only and
# is safe to commit as a template).
export_pgbackrest_env() {
  require_backup_destination
  require_env BACKUP_PG_CIPHER_PASS
  _parse_destination
  export PGBACKREST_REPO1_S3_ENDPOINT="$_S3_HOST"
  export PGBACKREST_REPO1_STORAGE_PORT="$_S3_PORT"
  export PGBACKREST_REPO1_S3_BUCKET="$BACKUP_S3_BUCKET"
  export PGBACKREST_REPO1_S3_REGION="${BACKUP_S3_REGION:-auto}"
  export PGBACKREST_REPO1_S3_KEY="$BACKUP_S3_KEY"
  export PGBACKREST_REPO1_S3_KEY_SECRET="$BACKUP_S3_KEY_SECRET"
  export PGBACKREST_REPO1_CIPHER_PASS="$BACKUP_PG_CIPHER_PASS"
  export PGBACKREST_REPO1_RETENTION_FULL="${BACKUP_PG_RETENTION_FULL:-8}"
  if [ "${BACKUP_S3_INSECURE_TLS:-}" = "1" ]; then
    # Still TLS, just without certificate verification. Only ever correct for a
    # self-signed local target such as the one in scripts/test-backup-restore.sh.
    export PGBACKREST_REPO1_STORAGE_VERIFY_TLS=n
    warn "BACKUP_S3_INSECURE_TLS=1 — destination certificate is NOT verified. Never set this against a real destination."
  fi
  [ -n "${BACKUP_PG_USER:-}" ] && export PGBACKREST_PG1_USER="$BACKUP_PG_USER"
  [ -n "${BACKUP_PG_DATABASE:-}" ] && export PGBACKREST_PG1_DATABASE="$BACKUP_PG_DATABASE"
  return 0
}

# Configure the `mc` alias for the BACKUP DESTINATION (write path).
# Credentials are passed via env, never `mc alias set` on a command line that
# would show up in `ps`.
mc_alias_destination() {
  require_backup_destination
  # Assigned separately from `export`: `export X="$(f)"` always returns 0, which
  # would swallow a failure inside _mc_url even under `set -e`.
  local url
  url="$(_mc_url "$BACKUP_S3_KEY" "$BACKUP_S3_KEY_SECRET" "$BACKUP_S3_ENDPOINT")"
  export MC_HOST_backup="$url"
}

# Configure the `mc` alias for the SOURCE MinIO (read path).
mc_alias_source() {
  require_env BACKUP_MINIO_ENDPOINT BACKUP_MINIO_ACCESS_KEY BACKUP_MINIO_SECRET_KEY
  local url
  url="$(_mc_url "$BACKUP_MINIO_ACCESS_KEY" "$BACKUP_MINIO_SECRET_KEY" "$BACKUP_MINIO_ENDPOINT")"
  export MC_HOST_source="$url"
}

# Build a MC_HOST_<alias> URL with percent-encoded credentials so that keys
# containing /, +, = or @ cannot break out of the URL.
_mc_url() {
  local key="$1" secret="$2" endpoint="$3"
  local scheme="${endpoint%%://*}" host="${endpoint#*://}"
  printf '%s://%s:%s@%s' "$scheme" "$(_urlencode "$key")" "$(_urlencode "$secret")" "$host"
}

_urlencode() {
  local s="$1" i c out=''
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Timestamped object key segment, sorts lexicographically by time.
backup_stamp() { date -u '+%Y/%m/%d/%Y%m%dT%H%M%SZ'; }
