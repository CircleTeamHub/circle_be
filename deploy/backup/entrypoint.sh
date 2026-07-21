#!/usr/bin/env bash
# Backup container entrypoint.
#
#   scheduler            (default) install the crontab from env and run crond
#   run <job> [args]     run one job now and exit — used by the restore drill,
#                        by `docker compose run --rm backup run pg-full`, and by
#                        anyone debugging a schedule
#   <anything else>      exec'd verbatim (psql, pgbackrest, mc, bash, ...)
#
# Which jobs this container schedules comes from BACKUP_JOBS (comma separated),
# set per-service in docker-compose.backup.yml rather than in .env.backup: the
# pg/minio scheduler and the OpenIM-Mongo scheduler are different services on
# different networks, but share this one image.
LOG_TAG=entrypoint
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

JOBS_DIR="$(dirname "$0")"

run_job() {
  case "${1:-}" in
    pg-full)   shift; exec "$JOBS_DIR/backup-postgres.sh" full "$@" ;;
    pg-diff)   shift; exec "$JOBS_DIR/backup-postgres.sh" diff "$@" ;;
    pg-incr)   shift; exec "$JOBS_DIR/backup-postgres.sh" incr "$@" ;;
    mongo)     shift; exec "$JOBS_DIR/backup-mongo.sh" "$@" ;;
    minio)     shift; exec "$JOBS_DIR/backup-minio.sh" "$@" ;;
    check)     shift; exec "$JOBS_DIR/check.sh" "$@" ;;
    drill)     shift; exec "$JOBS_DIR/drill.sh" "$@" ;;
    *) die "unknown job '${1:-}' (want: pg-full|pg-diff|pg-incr|mongo|minio|check|drill)" ;;
  esac
}

_schedule_for() {
  case "$1" in
    pg-full) printf '%s' "${BACKUP_CRON_PG_FULL:-0 3 * * 0}" ;;
    pg-diff) printf '%s' "${BACKUP_CRON_PG_DIFF:-0 3 * * 1-6}" ;;
    pg-incr) printf '%s' "${BACKUP_CRON_PG_INCR:-0 3 * * 1-6}" ;;
    minio)   printf '%s' "${BACKUP_CRON_MINIO:-*/15 * * * *}" ;;
    # Hourly, not daily. Each run is a FULL dump, so this is the direct
    # RPO-vs-cost knob for chat history: RPO == this interval, because OpenIM's
    # mongod is standalone (no --replSet => no oplog => no point-in-time
    # recovery). Daily would mean losing up to 24h of messages. See
    # docs/backups.md "RPO gap: chat history".
    mongo)   printf '%s' "${BACKUP_CRON_MONGO:-0 * * * *}" ;;
    check)   printf '%s' "${BACKUP_CRON_CHECK:-17 * * * *}" ;;
    *) die "unknown job in BACKUP_JOBS: '$1'" ;;
  esac
}

install_crontab() {
  # tmpfs: the crontab carries no secrets, but /etc is not writable by uid 70
  # and there is no reason to persist it.
  local dir=/run/crontabs job file
  mkdir -p "$dir"
  # busybox crond only runs the crontab whose filename matches the invoking user.
  file="$dir/$(id -un)"

  {
    printf 'SHELL=/bin/bash\n'
    printf 'PATH=%s\n' "$PATH"
    # Job output is redirected onto pid 1's handles so it lands in
    # `docker compose logs`. Otherwise busybox crond tries to mail it and, with
    # no MTA in the image, every backup log line is silently discarded.
    local IFS=,
    for job in ${BACKUP_JOBS:-pg-full,pg-diff,minio,check}; do
      printf '%s %s run %s >/proc/1/fd/1 2>/proc/1/fd/2\n' "$(_schedule_for "$job")" "$0" "$job"
    done
  } > "$file"

  log "scheduling jobs: ${BACKUP_JOBS:-pg-full,pg-diff,minio,check}"
  sed 's/^/  /' "$file"
  exec crond -f -l 8 -c "$dir"
}

case "${1:-scheduler}" in
  scheduler) install_crontab ;;
  run) shift; run_job "$@" ;;
  *) exec "$@" ;;
esac
