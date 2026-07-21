#!/usr/bin/env bash
# Restore OpenIM chat history from an encrypted mongodump archive.
#
# Usage:
#   restore-mongo.sh --identity <age-key-file> [--key <s3 key>] [--uri <mongo uri>] [--drop]
#
#   --identity  age private key file. This is NOT stored on the server: the
#               backup path only ever holds the PUBLIC key. Mount it read-only
#               for the duration of the restore and take it away afterwards.
#   --key       Object key to restore, e.g. mongo/2026/07/17/20260717T033000Z.archive.gz.age
#               Defaults to the most recent object under mongo/.
#   --uri       Target Mongo. Defaults to BACKUP_MONGO_URI (i.e. restore in place).
#   --drop      Drop each collection before restoring it. Off by default —
#               mongorestore otherwise merges into whatever is already there.
#
# List what is available:
#   mc ls --recursive backup/$BACKUP_S3_BUCKET/mongo/
LOG_TAG=mongo-restore
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

IDENTITY=""; KEY=""; URI=""; DROP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="${2:?--identity needs a path}"; shift 2 ;;
    --key)      KEY="${2:?--key needs an object key}"; shift 2 ;;
    --uri)      URI="${2:?--uri needs a mongo uri}"; shift 2 ;;
    --drop)     DROP=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$IDENTITY" ] || die "--identity <age-key-file> is required (the private key is not kept on this host)"
[ -r "$IDENTITY" ] || die "age identity file not readable: $IDENTITY"
URI="${URI:-${BACKUP_MONGO_URI:-}}"
[ -n "$URI" ] || die "no target: pass --uri or set BACKUP_MONGO_URI"

mc_alias_destination

if [ -z "$KEY" ]; then
  log "no --key given, selecting most recent object under mongo/"
  KEY="$(mc ls --recursive "backup/${BACKUP_S3_BUCKET}/mongo/" \
         | awk '{print $NF}' | sort | tail -1)"
  [ -n "$KEY" ] || die "no mongo backups found in s3://${BACKUP_S3_BUCKET}/mongo/"
  KEY="mongo/${KEY#mongo/}"
fi

CONF="$(mktemp -p /run circle-mongo-XXXXXX.conf)"
trap 'rm -f "$CONF"' EXIT
chmod 600 "$CONF"
printf 'uri: "%s"\n' "$URI" > "$CONF"

args=(--config="$CONF" --archive --gzip)
[ -n "$DROP" ] && args+=(--drop)

log "restoring s3://${BACKUP_S3_BUCKET}/${KEY}"
[ -n "$DROP" ] && warn "--drop: existing collections will be dropped first"

# Streamed straight through: the decrypted archive never lands on disk.
mc cat "backup/${BACKUP_S3_BUCKET}/${KEY}" \
  | age --decrypt -i "$IDENTITY" \
  | mongorestore "${args[@]}" 2>&1 | sed 's/^/  /'

log "mongo restore complete"
