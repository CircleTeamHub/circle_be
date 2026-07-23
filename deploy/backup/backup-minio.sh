#!/usr/bin/env bash
# MinIO object backup — avatars, chat attachments, note media.
#
# WHY `mc mirror` AND NOT MinIO BUCKET REPLICATION
# ------------------------------------------------
# MinIO's built-in server-side bucket replication only works MinIO -> MinIO:
# "server-side replication only works between MinIO deployments. Both the source
# and destination deployments must run MinIO" (mc replicate add reference), and
# the same docs redirect arbitrary S3-compatible targets to `mc mirror`.
# Replication additionally requires versioning on BOTH buckets, which Cloudflare
# R2 does not implement at all (PutBucketVersioning is on R2's unsupported list).
# So replication to R2/S3 is not an option here. `mc mirror` is still MinIO's own
# client, not a hand-rolled rsync.
#
# WHY NO --remove AND NO --overwrite
# ----------------------------------
# Upload keys are `<folder>/<userId>/<uuid>.<ext>` (src/upload/upload.service.ts)
# — write-once and never reused. So:
#   * omitting --remove  => deletes never propagate to the backup
#   * omitting --overwrite => existing backup objects can never be rewritten
# The mirror is therefore strictly accretive: an attacker holding the app's MinIO
# credentials can delete or corrupt the live bucket and none of it reaches the
# backup. That is what replaces the object-versioning protection R2 cannot offer.
# The cost is that the backup prefix only grows; see docs/backups.md for the
# retention/right-to-erasure implications.
LOG_TAG=minio-backup
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

require_env BACKUP_MINIO_BUCKET
mc_alias_source
mc_alias_destination

SRC="source/${BACKUP_MINIO_BUCKET}"
DEST="backup/${BACKUP_S3_BUCKET}/minio/${BACKUP_MINIO_BUCKET}"

log "mirroring ${SRC} -> s3://${BACKUP_S3_BUCKET}/minio/${BACKUP_MINIO_BUCKET}"

# Each run re-reconciles the full key space, so a run that dies halfway is
# repaired by the next one. This is why we schedule `mc mirror` rather than
# leaning on `mc mirror --watch`, whose resume-after-outage behaviour has
# long-standing upstream bugs (minio/mc#4883, #2105, #1560) and would silently
# leave gaps exactly when it matters.
mc mirror --quiet "$SRC" "$DEST" 2>&1 | sed 's/^/  /'

log "minio mirror complete"
