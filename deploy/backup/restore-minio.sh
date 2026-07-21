#!/usr/bin/env bash
# Restore objects (avatars, chat attachments, note media) from the off-host
# mirror back into MinIO.
#
# Usage: restore-minio.sh [--prefix <p>] [--overwrite] [--dry-run]
#
#   --prefix     Restore only keys under this prefix, e.g. avatars/.
#                Default: everything.
#   --overwrite  Replace objects that already exist in MinIO. Off by default:
#                keys are UUIDs and write-once, so an existing key normally means
#                "already restored", not "stale".
#   --dry-run    List what would be copied, copy nothing.
#
# Restoring needs credentials that can WRITE to MinIO. The scheduled backup path
# only ever needs read access to the source bucket — see docs/backups.md.
LOG_TAG=minio-restore
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

PREFIX=""; OVERWRITE=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)    PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --overwrite) OVERWRITE=1; shift ;;
    --dry-run)   DRY=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_env BACKUP_MINIO_BUCKET
mc_alias_source
mc_alias_destination

SRC="backup/${BACKUP_S3_BUCKET}/minio/${BACKUP_MINIO_BUCKET}/${PREFIX}"
DEST="source/${BACKUP_MINIO_BUCKET}/${PREFIX}"

args=(mirror)
[ -n "$OVERWRITE" ] && args+=(--overwrite)
[ -n "$DRY" ] && args+=(--dry-run)

log "restoring ${SRC} -> ${DEST}"
[ -n "$DRY" ] && log "dry run: nothing will be written"

# No --remove, ever: this must not delete live objects that are absent from the
# backup. Restore is additive.
mc "${args[@]}" "$SRC" "$DEST" 2>&1 | sed 's/^/  /'

log "minio restore complete"
