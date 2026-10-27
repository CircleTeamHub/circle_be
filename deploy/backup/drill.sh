#!/usr/bin/env bash
# RESTORE DRILL — the only thing that proves any of this works.
#
# An untested backup is not a backup. This restores the latest backup from the
# off-host repo into a scratch PGDATA, starts a throwaway postmaster on it,
# replays WAL, and compares exact per-table row counts against the live
# database. It NEVER touches the live cluster or the live data directory.
#
# The backup scheduler runs it weekly (BACKUP_CRON_DRILL, default Tuesday 19:30
# UTC = Wednesday 03:30 in China). Run it by hand after any change to the backup
# config:
#   docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml \
#     run --rm backup run drill
#
# Exit code is the result: 0 = the backup restored and matched, non-zero = you
# do not have a working backup, regardless of what the schedule logs say. Every
# run that gets past the lock also writes Prometheus textfiles (see
# write_drill_metrics) for the BackupRestoreDrill* alerts — before that, a drill
# nobody remembered to run looked exactly like a drill that passed.
#
# The restore replays WAL up to the end of the archive, i.e. to within about
# archive_timeout (60s) of "now". Row counts therefore drift BOTH ways while the
# drill runs: writes since the restore point make live > restored, and the
# retention sweepers deleting rows make restored > live. Neither is a failure.
# What fails the drill is what a broken restore actually looks like: no
# restore at all, a cluster that does not come up, a missing table, or a table
# with a real amount of data (DRILL_EMPTY_TABLE_MIN_ROWS) that comes back empty.
LOG_TAG=drill
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

DRILL_ROOT="${DRILL_ROOT:-/tmp/drill}"
while [ "${DRILL_ROOT%/}" != "$DRILL_ROOT" ]; do DRILL_ROOT="${DRILL_ROOT%/}"; done

DRILL_DIR="$DRILL_ROOT/data"
DRILL_SOCK="$DRILL_ROOT/sock"
# Written into DRILL_ROOT the moment the drill creates it. A PG_VERSION next to
# this marker is the drill's own restore left behind by a run that was killed
# (container recreated by a release, OOM, host restart: the EXIT trap never ran);
# a PG_VERSION without it is somebody's real cluster and is never touched.
DRILL_MARKER="$DRILL_ROOT/.circle-restore-drill"
DRILL_PORT=5433
LIVE_DB="${BACKUP_PG_DATABASE:-circle}"
LIVE_USER="${BACKUP_PG_USER:-circle}"
LIVE_PGDATA="${DRILL_LIVE_PGDATA:-/var/lib/postgresql/data}"
# The lock lives next to DRILL_ROOT, never inside it: the drill rm -rf's that.
# /tmp is the backup_scratch volume, shared by the scheduler and by every
# `run --rm backup run drill`, so the lock also excludes a manual drill that
# overlaps the scheduled one (each would otherwise delete the other's restore).
DRILL_LOCK="${DRILL_LOCK_FILE:-$(dirname "$DRILL_ROOT")/.drill.lock}"
METRICS_DIR="${BACKUP_METRICS_DIR:-/var/lib/circle-backup/metrics}"
# Space the restore may use, and what it must leave behind. The scratch volume
# sits on the same disk as the live cluster: a drill that fills it takes
# production Postgres down with it, so refuse up front rather than find out.
# 20%: HostDiskFilling warns below 15%, so a drill that leaves 10% would page
# every week while it runs.
DRILL_MIN_FREE_PERCENT="${DRILL_MIN_FREE_PERCENT:-20}"
DRILL_EMPTY_TABLE_MIN_ROWS="${DRILL_EMPTY_TABLE_MIN_ROWS:-1000}"
# Replaying a week of WAL on a big database takes longer than pg_ctl's default.
DRILL_START_TIMEOUT="${DRILL_START_TIMEOUT:-3600}"
# Counting one big table can still take minutes; naming the drill's connections
# lets PostgresLongTransaction leave them alone (and shows who they are in
# pg_stat_activity).
export PGAPPNAME=circle-restore-drill

# Exact counts for every base table in `public`. pg_stat_user_tables.n_live_tup
# is an estimate and is reset by a restore, so it cannot be used to compare a
# restored cluster against a live one.
#
# One statement per table (\gexec, autocommit): each count holds its table's
# ACCESS SHARE lock only while that one count runs. Counting every table in a
# single statement keeps all of those locks until the last table is done, and a
# migration's ALTER TABLE waiting behind one of them makes every later query on
# that table wait behind the ALTER — on the live database, every week.
COUNT_SCRIPT="SELECT format('SELECT %L || ''='' || count(*) FROM %I.%I', table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\\gexec"
# -X: no psqlrc, so nothing can turn autocommit off behind the drill's back.
count_tables() {
  printf '%s\n' "$COUNT_SCRIPT" | psql -X "$@" -At -v ON_ERROR_STOP=1 -f -
}

# Object backup spot check (step 7): how many keys to sample, and the age window.
# The mirror runs every 15 minutes, so anything older than two hours must have
# been copied by now.
DRILL_OBJECT_SAMPLE="${DRILL_OBJECT_SAMPLE:-20}"
case "$DRILL_OBJECT_SAMPLE" in ''|*[!0-9]*) DRILL_OBJECT_SAMPLE=20 ;; esac
DRILL_MC_TIMEOUT="${DRILL_MC_TIMEOUT:-30}"
OBJECTS_CHECKED=""
OBJECTS_MISSING=""
OBJECTS_GONE=""
OBJECTS_UNVERIFIABLE=""

# present | absent | error for one object. `mc stat` exits 1 for "no such
# object" and for every other failure alike, and for a bad credential, a missing
# bucket or an unreachable host it still ends with "Object does not exist" —
# after an "Unable to list folder" line carrying the real error. Only that one
# line on its own, with nothing else, is a genuine "not there". Bounded, because
# the scratch cluster (a second copy of the database) stays up meanwhile.
object_state() {
  local out flags=()
  [ "${BACKUP_S3_INSECURE_TLS:-}" = "1" ] && flags+=(--insecure)
  if out="$(timeout "$DRILL_MC_TIMEOUT" mc "${flags[@]}" stat --json "$1" 2>&1)"; then
    echo present
    return
  fi
  case "$out" in
    *'Unable to list folder'*) echo error ;;
    *'"message":"Object does not exist"'*) echo absent ;;
    *) echo error ;;
  esac
}

# Only ever removes a DRILL_ROOT this run owns: one it created or one carrying
# the marker. A refused DRILL_ROOT (a real PGDATA) is left exactly as it was.
OWN_ROOT=0
cleanup() {
  [ "$OWN_ROOT" -eq 1 ] || return 0
  if [ -d "$DRILL_DIR" ] && pg_ctl -D "$DRILL_DIR" status >/dev/null 2>&1; then
    log "stopping scratch postgres"
    pg_ctl -D "$DRILL_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$DRILL_ROOT"
}

# Which step the drill is in; the metrics label a failure with it so the alert
# says "restore failed" rather than just "drill failed".
STAGE=preflight
STARTED_AT="$(date +%s)"
RESTORE_POINT_AGE=""
# Set only by the lock-busy exit: the drill that holds the lock reports for both.
SKIP_METRICS=0

# Two files on purpose. backup_drill.prom is rewritten by every run;
# backup_drill_last_success.prom only by a passing one, so a failing drill can
# never move the "last proven restore" timestamp that BackupRestoreDrillStale
# watches. Same atomic temp+rename as check.sh: node-exporter only reads *.prom.
write_prom_file() {
  local name="$1" body="$2" tmp
  mkdir -p "$METRICS_DIR" 2>/dev/null || return 1
  tmp="$(mktemp "$METRICS_DIR/.$name.XXXXXX" 2>/dev/null)" || return 1
  if printf '%s' "$body" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$METRICS_DIR/$name.prom"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

write_drill_metrics() {
  local rc="$1" now ok stage body
  now="$(date +%s)"
  if [ "$rc" -eq 0 ]; then ok=1; stage=complete; else ok=0; stage="$STAGE"; fi
  body="# HELP circle_backup_drill_success Result of the last restore drill (1 = passed); stage is where a failed drill stopped.
# TYPE circle_backup_drill_success gauge
circle_backup_drill_success{stage=\"$stage\"} $ok
# HELP circle_backup_drill_last_run_timestamp_seconds Unix time the last restore drill finished.
# TYPE circle_backup_drill_last_run_timestamp_seconds gauge
circle_backup_drill_last_run_timestamp_seconds $now
# HELP circle_backup_drill_duration_seconds Wall time of the last restore drill.
# TYPE circle_backup_drill_duration_seconds gauge
circle_backup_drill_duration_seconds $(( now - STARTED_AT ))
"
  if [ -n "$OBJECTS_CHECKED" ]; then
    body="$body# HELP circle_backup_drill_objects_checked Sampled media objects the last drill looked up in the off-host copy.
# TYPE circle_backup_drill_objects_checked gauge
circle_backup_drill_objects_checked $OBJECTS_CHECKED
# HELP circle_backup_drill_objects_missing Sampled media objects present in the live bucket but missing from the off-host copy.
# TYPE circle_backup_drill_objects_missing gauge
circle_backup_drill_objects_missing $OBJECTS_MISSING
# HELP circle_backup_drill_objects_gone Sampled media objects the database references that are in neither the live bucket nor the off-host copy.
# TYPE circle_backup_drill_objects_gone gauge
circle_backup_drill_objects_gone $OBJECTS_GONE
# HELP circle_backup_drill_objects_unverifiable Sampled media objects the drill could not look up (object storage unreachable or credentials rejected).
# TYPE circle_backup_drill_objects_unverifiable gauge
circle_backup_drill_objects_unverifiable $OBJECTS_UNVERIFIABLE
"
  fi
  if [ -n "$RESTORE_POINT_AGE" ]; then
    body="$body# HELP circle_backup_drill_restore_point_age_seconds Age of the newest transaction the restored cluster contained when the drill read it.
# TYPE circle_backup_drill_restore_point_age_seconds gauge
circle_backup_drill_restore_point_age_seconds $RESTORE_POINT_AGE
"
  fi
  write_prom_file backup_drill "$body" \
    || warn "could not write drill metrics to $METRICS_DIR — the BackupRestoreDrill* alerts cannot see this run"
  if [ "$ok" -eq 1 ]; then
    write_prom_file backup_drill_last_success "# HELP circle_backup_drill_last_success_timestamp_seconds Unix time a restore drill last passed.
# TYPE circle_backup_drill_last_success_timestamp_seconds gauge
circle_backup_drill_last_success_timestamp_seconds $now
" || warn "could not record the drill success timestamp in $METRICS_DIR"
  fi
}

# Metrics first: under `set -e` a failing cleanup inside the trap would
# otherwise skip them, and the run would vanish without a result.
on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  [ "$SKIP_METRICS" -eq 1 ] || write_drill_metrics "$rc"
  cleanup
  exit "$rc"
}
trap on_exit EXIT

# This script rm -rf's DRILL_ROOT, and it runs in a container that mounts the
# LIVE pg_data volume read-write (pgbackrest has to read the data files it backs
# up). A mistyped DRILL_ROOT is therefore a delete-production button. Refuse
# anything that is not clearly a dedicated scratch directory — after the trap,
# so a misconfigured schedule fails loudly (stage="preflight") every week
# instead of exiting without a trace until BackupRestoreDrillStale.
case "$DRILL_ROOT" in
  /*/*) ;;
  *) die "DRILL_ROOT must be a dedicated absolute subdirectory such as /tmp/drill (got: '$DRILL_ROOT')" ;;
esac
case "$DRILL_ROOT" in
  /var|/var/lib|/var/lib/postgresql|/var/lib/postgresql/data|/var/lib/postgresql/data/*|/etc|/etc/*|/opt|/opt/*|/usr/*|/home/*|/root/*|/run/*|/proc/*|/sys/*|/dev/*)
    die "DRILL_ROOT='$DRILL_ROOT' is at or inside a system/live-data path — refusing to rm -rf it" ;;
esac
case "$DRILL_LOCK" in
  "$DRILL_ROOT"|"$DRILL_ROOT"/*) die "DRILL_LOCK_FILE must live outside DRILL_ROOT — the drill deletes DRILL_ROOT" ;;
esac

# Single-flight. A second drill exits 75 without touching the first one's files
# or metrics — the run in progress reports for both. Every child that can
# outlive this shell (the scratch postmaster) is started with fd 9 closed, so
# an orphan never holds the lock.
command -v flock >/dev/null 2>&1 || die "flock is not available — cannot guarantee a single drill at a time"
mkdir -p "$(dirname "$DRILL_LOCK")"
exec 9>"$DRILL_LOCK"
if ! flock -n 9; then
  SKIP_METRICS=1
  warn "another restore drill holds $DRILL_LOCK — not starting a second one"
  exit 75
fi

log "=== restore drill starting ==="

# ── 0. scratch space ──────────────────────────────────────────────────────────
if [ -e "$DRILL_MARKER" ]; then
  OWN_ROOT=1
  warn "removing the restore a previous, interrupted drill left in $DRILL_ROOT"
  cleanup
fi
# Belt and braces: a PG_VERSION without the marker means this is somebody's
# real cluster, whatever the path looks like.
for probe in "$DRILL_ROOT" "$DRILL_ROOT/data"; do
  [ -f "$probe/PG_VERSION" ] && die "DRILL_ROOT='$DRILL_ROOT' contains a real PGDATA ($probe/PG_VERSION) — refusing to destroy it. If it is a restore an older drill left behind, remove it by hand."
done
# Only a DRILL_ROOT that does not exist yet, or is an empty directory, becomes
# the drill's own. Anything else — /tmp itself pointed at by mistake, a shared
# directory, an older drill's unmarked leftover — is not ours to rm -rf.
if [ -e "$DRILL_ROOT" ]; then
  [ -d "$DRILL_ROOT" ] || die "DRILL_ROOT='$DRILL_ROOT' exists and is not a directory — refusing to touch it"
  entries="$(ls -A "$DRILL_ROOT")" || die "cannot list DRILL_ROOT='$DRILL_ROOT' — refusing to touch it"
  [ -z "$entries" ] || die "DRILL_ROOT='$DRILL_ROOT' is not empty and is not a drill's own scratch space — refusing to delete it. Point DRILL_ROOT at a dedicated directory (default /tmp/drill), or empty it by hand."
fi
OWN_ROOT=1
mkdir -p "$DRILL_ROOT"
: > "$DRILL_MARKER"

# ── 1. live counts ────────────────────────────────────────────────────────────
STAGE=live_counts
log "reading live row counts"
live="$(count_tables -h /var/run/postgresql -p 5432 -U "$LIVE_USER" -d "$LIVE_DB")" \
  || die "cannot read live database"
[ -n "$live" ] || die "live database has no tables in schema public — wrong target?"
log "live has $(printf '%s\n' "$live" | wc -l | tr -d ' ') tables"
# Where the newest segment archive_command has shipped starts (bytes). Replay
# must get at least that far: a restore that quietly stops at the base backup
# (archive-get failing, Postgres promoting anyway) passes every row count above
# now that counts may drift both ways. Empty when nothing was archived yet.
ARCHIVED_START="$(psql -h /var/run/postgresql -p 5432 -U "$LIVE_USER" -d "$LIVE_DB" -At -c "
  SELECT (s.segment_number * pg_size_bytes(current_setting('wal_segment_size')))::bigint
  FROM pg_stat_archiver a CROSS JOIN LATERAL pg_split_walfile_name(a.last_archived_wal) s
  WHERE a.last_archived_wal ~ '^[0-9A-F]{24}\$'" 2>/dev/null || true)"
case "$ARCHIVED_START" in ''|*[!0-9]*) ARCHIVED_START="" ;; esac

# ── 2. room for a second copy? ────────────────────────────────────────────────
# The restore writes roughly the live PGDATA again (plus WAL being replayed).
# du on a running cluster can trip over files that vanish mid-walk; the total
# it prints is still good, so only its output is trusted, not its exit code.
STAGE=space
live_kb="$( { du -sk "$LIVE_PGDATA" 2>/dev/null || true; } | awk 'NR==1 {print $1}')"
case "$live_kb" in ''|*[!0-9]*) die "cannot measure the live data directory $LIVE_PGDATA" ;; esac
df_line="$( { df -Pk "$DRILL_ROOT" 2>/dev/null || true; } | awk 'NR==2 {print $2, $4}')"
read -r fs_total_kb fs_avail_kb <<< "$df_line"
for kb in "$fs_total_kb" "$fs_avail_kb"; do
  case "$kb" in ''|*[!0-9]*) die "cannot read free space for $DRILL_ROOT" ;; esac
done
need_kb=$(( live_kb + live_kb / 10 + 1024 * 1024 ))
reserve_kb=$(( fs_total_kb * DRILL_MIN_FREE_PERCENT / 100 ))
log "restore needs ~$(( need_kb / 1024 ))MiB; $(( fs_avail_kb / 1024 ))MiB free, keeping $(( reserve_kb / 1024 ))MiB (${DRILL_MIN_FREE_PERCENT}%) untouched"
if [ $(( fs_avail_kb - need_kb )) -lt "$reserve_kb" ]; then
  die "not enough free disk for a second copy of the database next to the live one — free space or move backup_scratch before trusting this backup"
fi

# ── 3. restore latest into scratch ────────────────────────────────────────────
STAGE=restore
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
# nice: the live cluster shares this host's CPU; the drill can afford to be slow.
# One process (the conf allows two for backups): slower, and gentler on the
# disk the live cluster is using.
if ! nice -n 10 pgbackrest --stanza=circle --pg1-path="$DRILL_DIR" --delta --archive-mode=off \
     --process-max=1 restore >"$RESTORE_LOG" 2>&1; then
  sed 's/^/  /' "$RESTORE_LOG" >&2 2>/dev/null || true
  die "pgbackrest restore failed — THERE IS NO WORKING BACKUP"
fi
sed 's/^/  /' "$RESTORE_LOG"

# ── 4. start scratch postmaster, replay WAL ───────────────────────────────────
STAGE=start
log "starting scratch postgres on port $DRILL_PORT (replays WAL from the repo)"
# -l redirects the SERVER's output to a file. Do NOT pipe pg_ctl into anything:
# the postmaster it spawns inherits the pipe's write end and keeps it open for
# its whole life, so `pg_ctl start | sed` hangs forever even though the server
# came up fine.
#
# hot_standby=off: with it on (the default) the server accepts connections as
# soon as it is consistent, pg_ctl -w returns while WAL is still replaying, and
# everything below would read a half-recovered cluster. Off, connections are
# refused until recovery has finished and the cluster promoted. autovacuum=off
# and nice: this copy is read twice and thrown away, and it shares the host
# with production. 9>&-: the postmaster must not inherit the drill lock.
if ! nice -n 10 pg_ctl -D "$DRILL_DIR" -w -t "$DRILL_START_TIMEOUT" -l "$DRILL_ROOT/postgres.log" \
       -o "-p $DRILL_PORT -k $DRILL_SOCK -c listen_addresses='' -c archive_mode=off -c hot_standby=off -c autovacuum=off" \
       start >/dev/null 2>&1 9>&-; then
  warn "scratch postgres failed to start — restore is not usable:"
  sed 's/^/  /' "$DRILL_ROOT/postgres.log" >&2 2>/dev/null || true
  exit 1
fi
log "scratch postgres is up and finished recovery"

# ── 5. restored counts ────────────────────────────────────────────────────────
STAGE=query
log "reading restored row counts"
restored="$(count_tables -h "$DRILL_SOCK" -p "$DRILL_PORT" -U "$LIVE_USER" -d "$LIVE_DB")" \
  || die "cannot query the restored cluster"
# How recent the restored data is: the commit time of the last transaction WAL
# replay applied. Informational (it is old on a database nobody wrote to);
# whether WAL archiving keeps up is BackupCheckFailing's job.
RESTORE_POINT_AGE="$(psql -h "$DRILL_SOCK" -p "$DRILL_PORT" -U "$LIVE_USER" -d "$LIVE_DB" \
  -At -c "SELECT floor(extract(epoch FROM now() - pg_last_xact_replay_timestamp()))::bigint" 2>/dev/null || true)"
case "$RESTORE_POINT_AGE" in ''|*[!0-9]*) RESTORE_POINT_AGE="" ;; esac
[ -n "$RESTORE_POINT_AGE" ] && log "restored data reaches $(( RESTORE_POINT_AGE / 60 ))min before now"
# How far WAL replay got (bytes). Stays fixed after promotion.
REPLAYED_TO="$(psql -h "$DRILL_SOCK" -p "$DRILL_PORT" -U "$LIVE_USER" -d "$LIVE_DB" \
  -At -c "SELECT (pg_last_wal_replay_lsn() - '0/0'::pg_lsn)::bigint" 2>/dev/null || true)"
case "$REPLAYED_TO" in ''|*[!0-9]*) REPLAYED_TO="" ;; esac

# ── 6. compare ────────────────────────────────────────────────────────────────
STAGE=compare
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
  elif [ "$restored_n" -eq 0 ] && [ "$live_n" -ge "$DRILL_EMPTY_TABLE_MIN_ROWS" ]; then
    warn "  EMPTY    $table: live=$live_n restored=0 — table restored empty"
    rc=1
  elif [ "$restored_n" -gt "$live_n" ]; then
    drifted=$((drifted + 1))
    log "  drift    $table: live=$live_n restored=$restored_n (rows deleted since the restore point)"
  else
    drifted=$((drifted + 1))
    log "  drift    $table: live=$live_n restored=$restored_n (writes since the restore point)"
  fi
done <<< "$live"

if [ -n "$ARCHIVED_START" ] && [ -n "$REPLAYED_TO" ]; then
  if [ "$REPLAYED_TO" -lt "$ARCHIVED_START" ]; then
    warn "  BEHIND   WAL replay stopped at byte $REPLAYED_TO, before the newest segment archived when the drill started ($ARCHIVED_START) — the restore is missing archived WAL"
    rc=1
  else
    log "  ok       WAL replay reached the newest archived segment"
  fi
elif [ -n "$ARCHIVED_START" ]; then
  warn "  could not read how far WAL replay got — the restore may be missing archived WAL"
  rc=1
fi

log "=== drill result: ${matched} exact, ${drifted} drifted ==="

# ── 7. object backup spot check ───────────────────────────────────────────────
# Postgres is only half of a restore: avatars, chat attachments and note media
# live in MinIO and reach the off-host bucket through `mc mirror` (backup-minio.sh),
# and nothing else ever reads that copy back. Sample keys the database
# references — chat media messages, note media, note media forwarded into chats —
# and look each one up there. The mirror never deletes, so an object whose row is
# older than the window must be in the copy:
#   copy has it                 → checked
#   copy lacks it, live has it  → missing: the mirror lost it (fails the drill)
#   neither has it              → gone: the object vanished from live storage
#                                  although a live row still points at it — a
#                                  data problem, not a backup one (warned, counted)
#   lookup failed               → unverifiable: fails the drill, never "passes"
# Only runs when the database already restored cleanly, so the stage label
# always names the first thing that broke.
if [ "$rc" -eq 0 ]; then
  STAGE=objects
  if [ -z "${BACKUP_MINIO_ENDPOINT:-}" ] || [ -z "${BACKUP_MINIO_BUCKET:-}" ]; then
    log "object mirror not configured (BACKUP_MINIO_*) — skipping the object backup check"
  else
    # Split DRILL_OBJECT_SAMPLE over the three sources without exceeding it: the
    # remainder goes to chat messages first, then note media (20 → 7 / 7 / 6).
    base=$(( DRILL_OBJECT_SAMPLE / 3 )); extra=$(( DRILL_OBJECT_SAMPLE % 3 ))
    limit_chat=$(( base + (extra > 0 ? 1 : 0) ))
    limit_note=$(( base + (extra > 1 ? 1 : 0) ))
    limit_ref=$base
    window="\"createdAt\" BETWEEN now() - interval '14 days' AND now() - interval '2 hours'"
    keys="$(psql -h /var/run/postgresql -p 5432 -U "$LIVE_USER" -d "$LIVE_DB" -At -v ON_ERROR_STOP=1 -c "
      SELECT key FROM (
        (SELECT content->>'key' AS key FROM \"ChatMessage\"
          WHERE type IN ('image', 'video', 'voice', 'file') AND NOT deleted AND \"revokedAt\" IS NULL
            AND (\"burnExpiresAt\" IS NULL OR \"burnExpiresAt\" > now() + interval '1 hour')
            AND $window ORDER BY random() LIMIT $limit_chat)
        UNION
        (SELECT \"objectKey\" AS key FROM \"NoteMedia\" WHERE $window ORDER BY random() LIMIT $limit_note)
        UNION
        (SELECT \"objectKey\" AS key FROM \"ChatMediaReference\" WHERE $window ORDER BY random() LIMIT $limit_ref)
      ) sampled
      WHERE key ~ '^[A-Za-z0-9][A-Za-z0-9/._=-]*\$'")" || die "cannot sample media keys from the live database"
    mc_alias_source
    mc_alias_destination
    src="source/${BACKUP_MINIO_BUCKET}"
    copy="backup/${BACKUP_S3_BUCKET}/minio/${BACKUP_MINIO_BUCKET}"
    sampled=0; checked=0; missing=0; gone=0; unverifiable=0
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      sampled=$((sampled + 1))
      # Keys are <folder>/<userId>/<uuid>.<ext>: log the folder and file, never the user.
      shown="${key%%/*}/…/${key##*/}"
      case "$(object_state "$copy/$key")" in
        present) checked=$((checked + 1)); continue ;;
        error) unverifiable=$((unverifiable + 1)); continue ;;
      esac
      case "$(object_state "$src/$key")" in
        present)
          checked=$((checked + 1)); missing=$((missing + 1))
          warn "  MISSING  $shown is in the live bucket but not in the off-host copy" ;;
        absent)
          gone=$((gone + 1))
          warn "  GONE     $shown is referenced by a live row but exists in neither the live bucket nor the copy" ;;
        *) unverifiable=$((unverifiable + 1)) ;;
      esac
    done <<< "$keys"
    OBJECTS_CHECKED="$checked"
    OBJECTS_MISSING="$missing"
    OBJECTS_GONE="$gone"
    OBJECTS_UNVERIFIABLE="$unverifiable"
    log "objects: ${sampled} sampled, ${checked} checked, ${missing} missing from the off-host copy, ${gone} gone everywhere, ${unverifiable} unverifiable"
    if [ "$unverifiable" -gt 0 ]; then
      warn "  could not look up ${unverifiable} object(s) — object storage unreachable or credentials rejected; nothing about them is proven"
      rc=1
    fi
    if [ "$missing" -gt 0 ]; then
      warn "  the object mirror is not keeping up — media uploaded hours ago is not in the backup"
      rc=1
    fi
    if [ "$sampled" -gt 0 ] && [ "$checked" -eq 0 ]; then
      warn "  ${sampled} object(s) sampled and not one could be confirmed in the off-host copy"
      rc=1
    fi
  fi
fi

if [ "$rc" -eq 0 ]; then
  log "DRILL PASSED — the off-host backup restores to a queryable, consistent cluster"
else
  warn "DRILL FAILED — do not trust this backup"
fi
exit "$rc"
