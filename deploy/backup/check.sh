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

# Every result is also written as a Prometheus textfile, which the
# backup-metrics sidecar in docker-compose.backup.yml exports to the BackupCheck*
# alerts. Before that, a failing check only ever reached `docker compose logs` —
# i.e. nobody. A check that is not applicable (no backup yet, no source MinIO)
# is left out rather than reported as passing.
METRICS_DIR="${BACKUP_METRICS_DIR:-/var/lib/circle-backup/metrics}"
results=()
record() { results+=("circle_backup_check_success{check=\"$1\"} $2"); }

log "checking pgbackrest repo + WAL archiving"
if pgbackrest --stanza=circle check 2>&1 | sed 's/^/  /'; then
  log "OK  postgres: repo reachable and archive_command is landing WAL"
  record postgres_archive 1
else
  warn "FAIL postgres: pgbackrest check failed — WAL archiving is NOT working."
  warn "     Confirm postgres was started WITH docker-compose.backup.yml layered on"
  warn "     (archive_mode=on), and that BACKUP_S3_* credentials are still valid."
  rc=1
  record postgres_archive 0
fi

# Surface the age of the newest backup so a stalled schedule is visible.
if info="$(pgbackrest --stanza=circle --output=json info 2>/dev/null)"; then
  newest="$(printf '%s' "$info" | sed -n 's/.*"stop":\([0-9]*\).*/\1/p' | sort -n | tail -1)"
  if [ -n "$newest" ]; then
    age_h=$(( ( $(date +%s) - newest ) / 3600 ))
    log "newest backup finished ${age_h}h ago"
    if [ "$age_h" -gt 48 ]; then
      warn "FAIL no completed backup in ${age_h}h (expected daily)"
      rc=1
      record backup_freshness 0
    else
      record backup_freshness 1
    fi
  else
    warn "no completed backup found in repo yet"
  fi
fi

# The object mirror has no equivalent self-check; just prove the destination
# answers with the credentials we hold.
mc_alias_destination
if mc ls --quiet "backup/${BACKUP_S3_BUCKET}/" >/dev/null 2>&1; then
  log "OK  destination bucket reachable"
  record destination_bucket 1
else
  warn "FAIL destination bucket s3://${BACKUP_S3_BUCKET}/ not reachable with BACKUP_S3_* creds"
  rc=1
  record destination_bucket 0
fi

# 聊天记录不再需要独立检查:自研 chat 的三张表就在业务 Postgres 里,`pgbackrest check`
# 与上面的目的地新鲜度检查已经覆盖。(旧 OpenIM Mongo 的 dump 检查随该栈退役一并删除。)

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
    record minio_source 1
  else
    warn "FAIL source MinIO bucket ${BACKUP_MINIO_BUCKET} not readable — the object mirror is failing"
    rc=1
    record minio_source 0
  fi
fi

# Atomic replace: node-exporter reads only *.prom, so the temp file (no .prom
# suffix; busybox mktemp needs the XXXXXX at the very end) is never half-read.
# The timestamp is written last, by a run that got this far — a check that dies
# early leaves it to age, which is what BackupCheckStale watches.
write_metrics() {
  local tmp
  mkdir -p "$METRICS_DIR" 2>/dev/null || return 1
  tmp="$(mktemp "$METRICS_DIR/.backup_check.XXXXXX" 2>/dev/null)" || return 1
  if {
    printf '# HELP circle_backup_check_success Result of each backup self-check on its last run (1 = passed).\n'
    printf '# TYPE circle_backup_check_success gauge\n'
    printf '%s\n' "${results[@]}"
    printf '# HELP circle_backup_check_last_run_timestamp_seconds Unix time the backup self-check last completed.\n'
    printf '# TYPE circle_backup_check_last_run_timestamp_seconds gauge\n'
    printf 'circle_backup_check_last_run_timestamp_seconds %s\n' "$(date +%s)"
  } > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$METRICS_DIR/backup_check.prom"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}
write_metrics || warn "could not write backup metrics to $METRICS_DIR — the BackupCheck* alerts cannot see this run"

[ "$rc" -eq 0 ] && log "all checks passed" || warn "one or more checks FAILED"
exit "$rc"
