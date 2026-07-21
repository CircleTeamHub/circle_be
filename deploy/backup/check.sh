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

[ "$rc" -eq 0 ] && log "all checks passed" || warn "one or more checks FAILED"
exit "$rc"
