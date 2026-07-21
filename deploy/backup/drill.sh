#!/usr/bin/env bash
# RESTORE DRILL — the only thing that proves any of this works.
#
# An untested backup is not a backup. This restores the latest backup from the
# off-host repo into a scratch PGDATA, starts a throwaway postmaster on it,
# replays WAL, and compares exact per-table row counts against the live
# database. It NEVER touches the live cluster or the live data directory.
#
# Run it monthly, and after any change to the backup config:
#   docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml \
#     run --rm backup run drill
#
# Exit code is the result: 0 = the backup restored and matched, non-zero = you
# do not have a working backup, regardless of what the schedule logs say.
#
# On a busy database the live counts move forward while the drill runs, so a
# table reading "live > restored" is expected drift, not a failure. What is
# never OK is restored > live, or an empty table that has rows upstream — both
# mean the restore is wrong, and both fail the drill.
LOG_TAG=drill
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

DRILL_ROOT="${DRILL_ROOT:-/tmp/drill}"

# This script calls `rm -rf "$DRILL_ROOT"` twice, and it runs in a container that
# mounts the LIVE pg_data volume read-write (pgbackrest has to read the data
# files it backs up). A mistyped DRILL_ROOT is therefore a delete-production
# button. Refuse anything that is not clearly scratch space.
case "$DRILL_ROOT" in
  /*) ;;
  *) die "DRILL_ROOT must be an absolute path (got: '$DRILL_ROOT')" ;;
esac
case "$DRILL_ROOT" in
  /|/var|/var/lib|/var/lib/postgresql|/var/lib/postgresql/data|/var/lib/postgresql/data/*|/etc|/etc/*|/opt|/opt/*)
    die "DRILL_ROOT='$DRILL_ROOT' is at or inside a system/live-data path — refusing to rm -rf it" ;;
esac
# Belt and braces: a PG_VERSION file means this is somebody's real cluster,
# whatever the path looks like.
for probe in "$DRILL_ROOT" "$DRILL_ROOT/data"; do
  [ -f "$probe/PG_VERSION" ] && die "DRILL_ROOT='$DRILL_ROOT' contains a real PGDATA ($probe/PG_VERSION) — refusing to destroy it"
done

DRILL_DIR="$DRILL_ROOT/data"
DRILL_SOCK="$DRILL_ROOT/sock"
DRILL_PORT=5433
LIVE_DB="${BACKUP_PG_DATABASE:-circle}"
LIVE_USER="${BACKUP_PG_USER:-circle}"

# Exact counts for every base table in `public`. pg_stat_user_tables.n_live_tup
# is an estimate and is reset by a restore, so it cannot be used to compare a
# restored cluster against a live one.
COUNT_SQL="
SELECT table_name || '=' || (xpath('/row/cnt/text()', xml_count))[1]::text
FROM (
  SELECT table_name,
         query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', table_schema, table_name),
                      false, true, '') AS xml_count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
) t ORDER BY table_name;"

cleanup() {
  if [ -d "$DRILL_DIR" ] && pg_ctl -D "$DRILL_DIR" status >/dev/null 2>&1; then
    log "stopping scratch postgres"
    pg_ctl -D "$DRILL_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$DRILL_ROOT"
}
trap cleanup EXIT

log "=== restore drill starting ==="

# ── 1. live counts ────────────────────────────────────────────────────────────
log "reading live row counts"
live="$(psql -h /var/run/postgresql -p 5432 -U "$LIVE_USER" -d "$LIVE_DB" \
          -At -c "$COUNT_SQL")" || die "cannot read live database"
[ -n "$live" ] || die "live database has no tables in schema public — wrong target?"
log "live has $(printf '%s\n' "$live" | wc -l | tr -d ' ') tables"

# ── 2. restore latest into scratch ────────────────────────────────────────────
rm -rf "$DRILL_ROOT"
mkdir -p "$DRILL_DIR" "$DRILL_SOCK"
chmod 700 "$DRILL_DIR"
log "restoring latest backup into scratch dir $DRILL_DIR"
export_pgbackrest_env
# --archive-mode=off is what keeps this drill from pushing the scratch cluster's
# WAL into the production repo and forking its timeline.
#
# Output goes to a FILE, not through `| sed`. A pipe here deadlocks the whole
# drill: the postmaster started further down inherits this shell's stdout, holds
# the pipe's write end open for its entire life, and the sed therefore never
# sees EOF — so the script waits for sed, sed waits for the postmaster, and the
# postmaster waits to be stopped by the script. Observed as a drill that hangs
# forever with a perfectly healthy restored cluster sitting right there.
# Same footgun the pg_ctl comment below describes; it applies to every pipe that
# is open when the postmaster starts, not just pg_ctl's own.
RESTORE_LOG="$DRILL_ROOT/restore.log"
if ! pgbackrest --stanza=circle --pg1-path="$DRILL_DIR" --delta --archive-mode=off \
     restore >"$RESTORE_LOG" 2>&1; then
  sed 's/^/  /' "$RESTORE_LOG" >&2 2>/dev/null || true
  die "pgbackrest restore failed — THERE IS NO WORKING BACKUP"
fi
sed 's/^/  /' "$RESTORE_LOG"

# ── 3. start scratch postmaster, replay WAL ───────────────────────────────────
log "starting scratch postgres on port $DRILL_PORT (replays WAL from the repo)"
# -l redirects the SERVER's output to a file. Do NOT pipe pg_ctl into anything:
# the postmaster it spawns inherits the pipe's write end and keeps it open for
# its whole life, so `pg_ctl start | sed` hangs forever even though the server
# came up fine.
if ! pg_ctl -D "$DRILL_DIR" -w -t 300 -l "$DRILL_ROOT/postgres.log" \
       -o "-p $DRILL_PORT -k $DRILL_SOCK -c listen_addresses='' -c archive_mode=off" \
       start >/dev/null 2>&1; then
  warn "scratch postgres failed to start — restore is not usable:"
  sed 's/^/  /' "$DRILL_ROOT/postgres.log" >&2 2>/dev/null || true
  exit 1
fi
log "scratch postgres is up and finished recovery"

# ── 4. restored counts ────────────────────────────────────────────────────────
log "reading restored row counts"
restored="$(psql -h "$DRILL_SOCK" -p "$DRILL_PORT" -U "$LIVE_USER" -d "$LIVE_DB" \
              -At -c "$COUNT_SQL")" || die "cannot query the restored cluster"

# ── 5. compare ────────────────────────────────────────────────────────────────
log "=== comparison (table: live vs restored) ==="
rc=0; matched=0; drifted=0
while IFS='=' read -r table live_n; do
  [ -n "$table" ] || continue
  restored_n="$(printf '%s\n' "$restored" | sed -n "s/^${table}=//p")"
  if [ -z "$restored_n" ]; then
    warn "  MISSING  $table — present live, absent in restore"; rc=1; continue
  fi
  if [ "$live_n" -eq "$restored_n" ]; then
    matched=$((matched + 1))
    log "  ok       $table: $live_n"
  elif [ "$restored_n" -gt "$live_n" ]; then
    warn "  IMPOSSIBLE $table: live=$live_n restored=$restored_n — restore has rows live does not"
    rc=1
  elif [ "$restored_n" -eq 0 ] && [ "$live_n" -gt 0 ]; then
    warn "  EMPTY    $table: live=$live_n restored=0 — table restored empty"
    rc=1
  else
    drifted=$((drifted + 1))
    log "  drift    $table: live=$live_n restored=$restored_n (writes since backup)"
  fi
done <<< "$live"

log "=== drill result: ${matched} exact, ${drifted} drifted-forward ==="
if [ "$rc" -eq 0 ]; then
  log "DRILL PASSED — the off-host backup restores to a queryable, consistent cluster"
else
  warn "DRILL FAILED — do not trust this backup"
fi
exit "$rc"
