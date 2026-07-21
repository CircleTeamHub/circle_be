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

# The upload is NOT allowed to fail silently, and a failed upload is NOT allowed
# to leave an object behind.
#
# `mongodump | age | mc pipe` looks safe under pipefail, but it is not: if
# mongodump dies (bad credentials, Mongo restarted, network gone), age still
# sees a clean EOF and emits a STRUCTURALLY VALID age file wrapping zero bytes,
# and mc pipe uploads it. pipefail then fails the script — but the object is
# already in the bucket, and restore-mongo.sh without --key picks "the newest
# object under mongo/". That is exactly the object it would pick, so the day you
# need chat history you restore an empty database.
#
# So: run the pipeline under `if !` (which does not trip set -e), and on any
# failure delete what was uploaded before failing the run.
discard_partial() {
  warn "removing partial/empty object so a later restore cannot select it: $DEST"
  mc rm --force "$DEST" >/dev/null 2>&1 \
    || warn "could NOT remove $DEST — delete it by hand before the next restore"
}

if ! mongodump --config="$CONF" --archive --gzip --quiet \
     | age -r "$BACKUP_AGE_RECIPIENT" \
     | mc pipe --quiet "$DEST"; then
  discard_partial
  die "mongodump/age/upload failed — no usable backup was produced"
fi

# Size is a second, independent gate: it catches the case where every process in
# the pipeline exits 0 but the dump was empty anyway (e.g. the URI authenticated
# against an empty database). age itself has ~200 bytes of header+MAC overhead,
# so anything under the floor is an empty payload, not a small database.
SIZE="$(mc stat --json "$DEST" 2>/dev/null | sed -n 's/.*"size":\([0-9]*\).*/\1/p' | head -1)"
case "$SIZE" in
  ''|*[!0-9]*) discard_partial; die "cannot read the size of $DEST — treating as failed" ;;
esac
if [ "$SIZE" -lt "${BACKUP_MONGO_MIN_BYTES:-1024}" ]; then
  discard_partial
  die "uploaded object is only ${SIZE}B (< ${BACKUP_MONGO_MIN_BYTES:-1024}B) — the dump was empty"
fi
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
