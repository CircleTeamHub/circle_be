#!/usr/bin/env bash
# Health check for the backup system. Runs hourly.
#
# This exists because the two ways this system dies are both SILENT:
#   1. Someone runs `docker compose -f docker-compose.prod.yml up -d` without
#      the backup overlay. postgres gets recreated from the base definition,
#      archive_mode goes back to off, and WAL archiving just... stops. Nothing
#      errors. The next restore silently loses everything since that moment.
#   2. The S3 credentials expire/rotate and archive-push starts failing.
#
# `pgbackrest check` catches both: it verifies the repo is reachable AND forces
# a WAL switch, then confirms the segment actually landed in the repo.
LOG_TAG=backup-check
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

export_pgbackrest_env

rc=0

log "checking pgbackrest repo + WAL archiving"
if pgbackrest --stanza=circle check 2>&1 | sed 's/^/  /'; then
  log "OK  postgres: repo reachable and archive_command is landing WAL"
else
  warn "FAIL postgres: pgbackrest check failed — WAL archiving is NOT working."
  warn "     Confirm postgres was started WITH docker-compose.backup.yml layered on"
  warn "     (archive_mode=on), and that BACKUP_S3_* credentials are still valid."
  rc=1
fi

# Surface the age of the newest backup so a stalled schedule is visible.
if info="$(pgbackrest --stanza=circle --output=json info 2>/dev/null)"; then
  newest="$(printf '%s' "$info" | sed -n 's/.*"stop":\([0-9]*\).*/\1/p' | sort -n | tail -1)"
  if [ -n "$newest" ]; then
    age_h=$(( ( $(date +%s) - newest ) / 3600 ))
    log "newest backup finished ${age_h}h ago"
    [ "$age_h" -gt 48 ] && { warn "FAIL no completed backup in ${age_h}h (expected daily)"; rc=1; }
  else
    warn "no completed backup found in repo yet"
  fi
fi

# The object mirror has no equivalent self-check; just prove the destination
# answers with the credentials we hold.
mc_alias_destination
if mc ls --quiet "backup/${BACKUP_S3_BUCKET}/" >/dev/null 2>&1; then
  log "OK  destination bucket reachable"
else
  warn "FAIL destination bucket s3://${BACKUP_S3_BUCKET}/ not reachable with BACKUP_S3_* creds"
  rc=1
fi

# ── chat history ──────────────────────────────────────────────────────────────
# `pgbackrest check` covers Postgres and nothing else. Without the block below,
# the mongo dump — every message in the product — could fail on every single run
# (OpenIM rotated its Mongo password, the openim network went away, the age
# recipient is malformed) and this check would still print "all checks passed",
# because the only thing it proved was that the DESTINATION answers.
#
# Freshness, not reachability, is the property that matters: the dump is a full
# dump on a fixed schedule, so "nothing new landed" is the failure signal.
#
# Presence of any object under mongo/ is what tells us the mongo job is supposed
# to be running at all — backup_mongo is profile-gated and legitimately absent
# until OpenIM is deployed (DEPLOY.md stage 5), and an unconfigured job must not
# raise a false alarm.
MONGO_PREFIX="backup/${BACKUP_S3_BUCKET}/mongo/"
if [ -n "$(mc ls --recursive "$MONGO_PREFIX" 2>/dev/null | head -1)" ]; then
  # A duration string, not a bare hour count: `mc find` takes 7d10h31s form, and
  # expressing the threshold the same way keeps it honest for sub-hour schedules
  # (and lets the test suite drive it to 1s to prove the alarm actually fires).
  max_age="${BACKUP_CHECK_MONGO_MAX_AGE:-3h}"
  if [ -n "$(mc find "$MONGO_PREFIX" --newer-than "$max_age" 2>/dev/null | head -1)" ]; then
    log "OK  mongo: a chat-history dump landed within ${max_age}"
  else
    warn "FAIL mongo: NO chat-history dump in the last ${max_age}."
    warn "     Chat history is not being backed up. Check the backup_mongo service:"
    warn "     docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml logs backup_mongo"
    rc=1
  fi
else
  log "skip mongo: nothing under mongo/ yet (backup_mongo profile not enabled)"
fi

# ── object mirror ─────────────────────────────────────────────────────────────
# The mirror cannot be checked by freshness: it only creates objects when users
# upload, so a quiet week is indistinguishable from a broken mirror. What CAN
# rot silently is the SOURCE credential — the destination side is already
# covered above, and a dead source key makes every mirror run fail while the
# destination keeps answering happily.
if [ -n "${BACKUP_MINIO_ENDPOINT:-}" ] && [ -n "${BACKUP_MINIO_BUCKET:-}" ]; then
  mc_alias_source
  if mc ls --quiet "source/${BACKUP_MINIO_BUCKET}/" >/dev/null 2>&1; then
    log "OK  source MinIO bucket readable with BACKUP_MINIO_* creds"
  else
    warn "FAIL source MinIO bucket ${BACKUP_MINIO_BUCKET} not readable — the object mirror is failing"
    rc=1
  fi
fi

[ "$rc" -eq 0 ] && log "all checks passed" || warn "one or more checks FAILED"
exit "$rc"
