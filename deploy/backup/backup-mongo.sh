#!/usr/bin/env bash
# OpenIM Mongo backup — this is every chat message in the product.
#
# OpenIM runs as a separate compose stack (openim-docker) that we do not own and
# must not modify. We reach its Mongo purely from our side: this container joins
# the OpenIM compose network read-only and authenticates with credentials the
# operator supplies in .env.backup. Nothing is installed into that stack.
#
# Pipeline: mongodump --archive --gzip | age -r <PUBLIC key> | mc pipe -> S3
# Nothing hits local disk, and the archive is encrypted to a public key, so a
# full compromise of this host still cannot decrypt any existing Mongo backup.
LOG_TAG=mongo-backup
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

require_env BACKUP_MONGO_URI BACKUP_AGE_RECIPIENT
mc_alias_destination

STAMP="$(backup_stamp)"
KEY="mongo/${STAMP}.archive.gz.age"
DEST="backup/${BACKUP_S3_BUCKET}/${KEY}"

# Keep the URI (which carries the Mongo password) off the process command line
# and out of the host's `ps` output. /run is a tmpfs in the compose service, so
# this never reaches disk.
CONF="$(mktemp -p /run circle-mongo-XXXXXX.conf)"
trap 'rm -f "$CONF"' EXIT
chmod 600 "$CONF"
printf 'uri: "%s"\n' "$BACKUP_MONGO_URI" > "$CONF"

log "dumping OpenIM Mongo -> s3://${BACKUP_S3_BUCKET}/${KEY}"
# pipefail (set in lib.sh) makes a mongodump or age failure fail the whole run
# instead of silently shipping a truncated/empty archive.
mongodump --config="$CONF" --archive --gzip --quiet \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  | mc pipe --quiet "$DEST"

SIZE="$(mc stat --json "$DEST" 2>/dev/null | sed -n 's/.*"size":\([0-9]*\).*/\1/p' | head -1)"
[ -n "$SIZE" ] && [ "$SIZE" -gt 0 ] || die "uploaded object is missing or empty: $DEST"
log "uploaded ${SIZE} bytes"

# Best-effort pruning. Deliberately non-fatal: if the destination has an
# immutability window (R2 Bucket Lock / S3 Object Lock) that is longer than
# this retention, these deletes are SUPPOSED to fail, and that must not mark a
# good backup as failed. Prefer a bucket lifecycle rule on the mongo/ prefix.
if [ -n "${BACKUP_MONGO_RETENTION_DAYS:-}" ]; then
  log "pruning mongo dumps older than ${BACKUP_MONGO_RETENTION_DAYS}d (best effort)"
  mc rm --recursive --force --older-than "${BACKUP_MONGO_RETENTION_DAYS}d" \
     "backup/${BACKUP_S3_BUCKET}/mongo/" 2>&1 | sed 's/^/  /' \
     || warn "prune failed (expected if an object-lock window covers these keys)"
fi

log "mongo backup complete"
