#!/usr/bin/env bash
# Postgres backup via pgBackRest -> off-host S3-compatible repo.
#
# Usage: backup-postgres.sh [full|diff|incr]
#
# This only takes the periodic full/diff/incr snapshots. The thing that
# actually buys the RPO target is continuous WAL archiving, which runs from the
# postgres container's archive_command (see docker-compose.backup.yml) on every
# segment switch — not from here.
LOG_TAG=pg-backup
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

TYPE="${1:-incr}"
case "$TYPE" in
  full|diff|incr) ;;
  *) die "unknown backup type '$TYPE' (want: full|diff|incr)" ;;
esac

export_pgbackrest_env

# stanza-create is idempotent; on an already-initialised repo it is a no-op.
# Doing it here means a fresh host bootstraps itself on the first run instead of
# requiring a manual step that someone will forget.
log "ensuring stanza exists"
if ! pgbackrest --stanza=circle stanza-create 2>&1 | sed 's/^/  /'; then
  log "stanza-create reported nothing to do (already initialised)"
fi

log "starting $TYPE backup"
pgbackrest --stanza=circle --type="$TYPE" backup 2>&1 | sed 's/^/  /'

# expire is the ONLY thing allowed to delete from the /pgbackrest prefix.
# repo1-retention-full comes from BACKUP_PG_RETENTION_FULL.
log "expiring old backups (retention-full=${BACKUP_PG_RETENTION_FULL:-8})"
pgbackrest --stanza=circle expire 2>&1 | sed 's/^/  /'

log "$TYPE backup complete"
