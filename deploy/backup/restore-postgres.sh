#!/usr/bin/env bash
# Restore Postgres from the off-host pgBackRest repo.
#
# Usage:
#   restore-postgres.sh --to <dir> [--time "YYYY-MM-DD HH:MM:SS+00"] [--set <label>]
#
#   --to <dir>   Target PGDATA. Use /var/lib/postgresql/data for a real
#                disaster recovery (postgres MUST be stopped first), or a
#                scratch path for a drill.
#   --time       Point-in-time recovery target. Omit to replay the whole WAL
#                stream, i.e. recover as close to "now" as the archive allows.
#   --set        Restore from a specific backup label instead of the latest.
#
# Run `pgbackrest --stanza=circle info` first to see what is available.
LOG_TAG=pg-restore
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

TARGET_DIR=""; TARGET_TIME=""; BACKUP_SET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to)   TARGET_DIR="${2:?--to needs a path}"; shift 2 ;;
    --time) TARGET_TIME="${2:?--time needs a timestamp}"; shift 2 ;;
    --set)  BACKUP_SET="${2:?--set needs a backup label}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$TARGET_DIR" ] || die "--to <dir> is required"

export_pgbackrest_env

# Refuse to restore over a RUNNING postgres. pgBackRest would otherwise happily
# overwrite the data directory underneath a live postmaster.
if [ -S /var/run/postgresql/.s.PGSQL.5432 ] \
   && pg_isready -h /var/run/postgresql -q 2>/dev/null; then
  die "postgres is still running — stop it before restoring (docker compose stop postgres)"
fi

args=(--stanza=circle --pg1-path="$TARGET_DIR" restore)

# --delta lets us restore onto a non-empty directory by comparing checksums,
# which is both faster and what you want during a real recovery.
args+=(--delta)

# THE IMPORTANT ONE. Without this the restored cluster inherits archive_mode=on
# and starts pushing its own WAL into the SAME repo it was just restored from,
# forking the timeline into the live backup set and corrupting it. Every restore
# — drill or real — must come up with archiving off. Re-enable deliberately only
# once the restored cluster is the new production.
args+=(--archive-mode=off)

if [ -n "$BACKUP_SET" ]; then
  args+=(--set="$BACKUP_SET")
  log "restoring backup set $BACKUP_SET -> $TARGET_DIR"
else
  log "restoring latest backup -> $TARGET_DIR"
fi

if [ -n "$TARGET_TIME" ]; then
  args+=(--type=time --target="$TARGET_TIME" --target-action=promote)
  log "point-in-time target: $TARGET_TIME"
else
  log "no --time given: will replay all archived WAL (recovers to latest)"
fi

mkdir -p "$TARGET_DIR"
chmod 700 "$TARGET_DIR"
pgbackrest "${args[@]}" 2>&1 | sed 's/^/  /'

log "restore staged into $TARGET_DIR"
log "start postgres against it to replay WAL, e.g.:"
log "  pg_ctl -D $TARGET_DIR -o '-c archive_mode=off' -w start"
