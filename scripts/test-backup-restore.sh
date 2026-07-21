#!/usr/bin/env bash
# End-to-end proof that the backup system actually restores.
#
#   backup -> write more -> DESTROY the data dir -> restore -> compare rows
#
# A backup script that has never restored anything is not a backup system, so
# this is the deliverable, not a nicety. It runs the REAL artifacts —
# docker-compose.prod.yml + docker-compose.backup.yml, docker/postgres/Dockerfile,
# docker/backup/Dockerfile, deploy/backup/*.sh — against a throwaway compose
# project and a local MinIO standing in for R2/S3. Nothing outside the
# circle-backup-drill-$$ project is touched.
#
# What it proves, in order:
#   1. pgBackRest can write an encrypted repo to an S3-compatible destination.
#   2. Rows written BEFORE the full backup survive a total loss of PGDATA.
#   3. Rows written AFTER the full backup also survive — i.e. continuous WAL
#      archiving works. This is the RPO claim; without it the whole thing
#      degrades to "nightly dump" and the 15min target is fiction.
#   4. Rows archived ONLY by archive_timeout (no manual pg_switch_wal) survive,
#      which is what bounds RPO in normal operation.
#
# Usage: scripts/test-backup-restore.sh
set -euo pipefail

project="circle-backup-drill-$$"
tmp_env="tmp/backup-test-$$.env"
tmp_override="tmp/backup-test-$$.yml"
# archive_timeout in docker-compose.backup.yml. Step 4 waits this out for real
# rather than mocking it — that is the number the RPO claim rests on.
archive_timeout=60

compose=(docker compose -p "$project"
         -f docker-compose.prod.yml
         -f docker-compose.backup.yml
         -f "$tmp_override")

# docker-compose.prod.yml interpolates these; values are irrelevant here because
# only postgres/backup are ever started.
export DB_PASSWORD=test-only-db-password
export MINIO_ROOT_USER=test-only-minio
export MINIO_ROOT_PASSWORD=test-only-minio-password
export API_DOMAIN=api.example.test
export ADMIN_DOMAIN=admin.example.test
export ACME_EMAIL=ops@example.test
# Deliberately bogus: proves the openim-backup profile really is optional and a
# missing OpenIM stack does not stop Postgres/MinIO backups from running.
export OPENIM_NETWORK="definitely-not-a-real-network-$$"

certs_dir="tmp/backup-test-certs-$$"

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_env" "$tmp_override" "$certs_dir"
}
trap cleanup EXIT INT TERM

mkdir -p tmp
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { printf '\n=== %s\n' "$*"; }

s3_key="drilltest"
s3_secret="$(openssl rand -hex 20)"

# pgBackRest cannot speak plaintext to an S3 repo — there is no http option, only
# a certificate-verification toggle — so the stand-in destination has to serve
# real TLS. Self-signed is fine here precisely because BACKUP_S3_INSECURE_TLS=1
# turns verification off, which is the one and only place that flag belongs.
mkdir -p "$certs_dir"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$certs_dir/private.key" -out "$certs_dir/public.crt" \
  -subj "/CN=backup-s3" -addext "subjectAltName=DNS:backup-s3" >/dev/null 2>&1 \
  || fail "could not generate a self-signed cert for the test destination"
chmod 644 "$certs_dir/private.key"

# tmp/ is gitignored. The real .env.backup is never read or written by this test.
cat > "$tmp_env" <<EOF
BACKUP_S3_ENDPOINT=https://backup-s3:9000
BACKUP_S3_INSECURE_TLS=1
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=circle-backup-test
BACKUP_S3_KEY=$s3_key
BACKUP_S3_KEY_SECRET=$s3_secret
BACKUP_PG_CIPHER_PASS=$(openssl rand -base64 36)
BACKUP_PG_USER=circle
BACKUP_PG_DATABASE=circle
BACKUP_PG_RETENTION_FULL=2
BACKUP_MINIO_ENDPOINT=http://minio:9000
BACKUP_MINIO_ACCESS_KEY=$MINIO_ROOT_USER
BACKUP_MINIO_SECRET_KEY=$MINIO_ROOT_PASSWORD
BACKUP_MINIO_BUCKET=circle
EOF

# env_file is replaced (not merged) via !override so the operator's real
# .env.backup is neither required nor read.
cat > "$tmp_override" <<EOF
services:
  backup-s3:
    image: minio/minio:RELEASE.2025-09-07T16-13-09Z
    environment:
      MINIO_ROOT_USER: $s3_key
      MINIO_ROOT_PASSWORD: $s3_secret
    command: server /data --certs-dir /certs
    volumes:
      - ./$certs_dir:/certs:ro
    # NOT \`mc ready local\`: the image's preconfigured "local" alias is http,
    # so it breaks as soon as the server is TLS-only. The health endpoint needs
    # no auth and does not care.
    healthcheck:
      test: ['CMD', 'curl', '-sk', '--max-time', '5', '-o', '/dev/null', 'https://127.0.0.1:9000/minio/health/live']
      interval: 3s
      timeout: 5s
      retries: 20

  backup-s3-init:
    image: minio/mc:RELEASE.2025-08-13T08-35-41Z
    depends_on:
      backup-s3: { condition: service_healthy }
    environment:
      MC_HOST_d: https://$s3_key:$s3_secret@backup-s3:9000
    entrypoint: ['mc', '--insecure', 'mb', '-p', 'd/circle-backup-test']
    restart: 'no'

  postgres:
    env_file: !override
      - $tmp_env
    depends_on:
      backup-s3-init: { condition: service_completed_successfully }

  backup:
    env_file: !override
      - $tmp_env
EOF

step "1. starting throwaway postgres (WAL archiving on) + S3 stand-in"
if ! up_out="$("${compose[@]}" up -d --build postgres 2>&1)"; then
  printf '%s\n' "$up_out" >&2
  "${compose[@]}" logs --tail 40 backup-s3 backup-s3-init postgres >&2 2>/dev/null || true
  fail "stack did not start"
fi

for _ in $(seq 1 90); do
  [ "$("${compose[@]}" ps postgres --format '{{.Health}}' 2>/dev/null)" = healthy ] && break
  sleep 1
done
[ "$("${compose[@]}" ps postgres --format '{{.Health}}' 2>/dev/null)" = healthy ] \
  || { "${compose[@]}" logs --tail 40 postgres >&2 2>/dev/null || true; fail "postgres never became healthy"; }

psql() { "${compose[@]}" exec -T postgres psql -U circle -d circle -At "$@"; }

step "2. confirming archive_mode is actually on"
[ "$(psql -c 'SHOW archive_mode')" = on ] || fail "archive_mode is not on"
[ "$(psql -c 'SHOW archive_timeout')" = "1min" ] || fail "archive_timeout is not 60s"
echo "  archive_mode=on archive_timeout=1min archive_command=$(psql -c 'SHOW archive_command')"

step "3. seeding data BEFORE the full backup"
psql -c "CREATE TABLE drill (id serial PRIMARY KEY, phase text NOT NULL, at timestamptz DEFAULT now());" >/dev/null
psql -c "INSERT INTO drill (phase) SELECT 'before-backup' FROM generate_series(1, 1000);" >/dev/null
before="$(psql -c "SELECT count(*) FROM drill;")"
echo "  rows before backup: $before"

step "4. taking a full backup (exercises deploy/backup/backup-postgres.sh)"
"${compose[@]}" run --rm --no-deps backup run pg-full 2>&1 | sed 's/^/  /' \
  || fail "pg-full backup failed"

step "5. writing MORE rows AFTER the backup (only WAL can recover these)"
psql -c "INSERT INTO drill (phase) SELECT 'after-backup' FROM generate_series(1, 500);" >/dev/null
psql -c "SELECT pg_switch_wal();" >/dev/null
sleep 5

step "6. writing rows recovered ONLY by archive_timeout (no manual switch)"
psql -c "INSERT INTO drill (phase) SELECT 'timeout-archived' FROM generate_series(1, 250);" >/dev/null
echo "  waiting ${archive_timeout}s for archive_timeout to force the segment switch..."
sleep $(( archive_timeout + 15 ))

expected="$(psql -c "SELECT count(*) FROM drill;")"
expected_before="$(psql -c "SELECT count(*) FROM drill WHERE phase='before-backup';")"
expected_after="$(psql -c "SELECT count(*) FROM drill WHERE phase='after-backup';")"
expected_timeout="$(psql -c "SELECT count(*) FROM drill WHERE phase='timeout-archived';")"
last_write="$(psql -c "SELECT max(at) FROM drill;")"
echo "  live totals: $expected (before=$expected_before after=$expected_after timeout=$expected_timeout)"

step "7. DESTROYING the data directory (simulates disk loss / down -v)"
"${compose[@]}" stop postgres >/dev/null
vol="${project}_pg_data"
docker run --rm -v "$vol":/d alpine:3.20 sh -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null; ls -A /d' \
  | grep -q . && fail "PGDATA was not actually emptied"
echo "  PGDATA is now empty — the only copy of this data is in the off-host repo"

step "8. restoring from the repo (exercises deploy/backup/restore-postgres.sh)"
"${compose[@]}" run --rm --no-deps backup \
  /opt/backup/restore-postgres.sh --to /var/lib/postgresql/data 2>&1 | sed 's/^/  /' \
  || fail "restore failed"

step "9. starting postgres on the restored dir (replays WAL, promotes)"
"${compose[@]}" start postgres >/dev/null
for _ in $(seq 1 90); do
  [ "$("${compose[@]}" ps postgres --format '{{.Health}}' 2>/dev/null)" = healthy ] && break
  sleep 1
done
[ "$("${compose[@]}" ps postgres --format '{{.Health}}' 2>/dev/null)" = healthy ] \
  || { "${compose[@]}" logs --tail 50 postgres >&2; fail "restored postgres never became healthy"; }

step "10. comparing row counts"
got="$(psql -c "SELECT count(*) FROM drill;")"
got_before="$(psql -c "SELECT count(*) FROM drill WHERE phase='before-backup';")"
got_after="$(psql -c "SELECT count(*) FROM drill WHERE phase='after-backup';")"
got_timeout="$(psql -c "SELECT count(*) FROM drill WHERE phase='timeout-archived';")"
got_last="$(psql -c "SELECT max(at) FROM drill;")"

printf '  %-18s %10s %10s\n' "phase" "expected" "restored"
printf '  %-18s %10s %10s\n' "before-backup"    "$expected_before"  "$got_before"
printf '  %-18s %10s %10s\n' "after-backup"     "$expected_after"   "$got_after"
printf '  %-18s %10s %10s\n' "timeout-archived" "$expected_timeout" "$got_timeout"
printf '  %-18s %10s %10s\n' "TOTAL"            "$expected"         "$got"

[ "$got_before" = "$expected_before" ]   || fail "pre-backup rows lost: expected $expected_before got $got_before"
[ "$got_after" = "$expected_after" ]     || fail "post-backup rows lost — WAL archiving is NOT working: expected $expected_after got $got_after"
[ "$got_timeout" = "$expected_timeout" ] || fail "archive_timeout rows lost — RPO claim is invalid: expected $expected_timeout got $got_timeout"
[ "$got" = "$expected" ]                 || fail "row count mismatch: expected $expected got $got"

step "11. restore drill script against the restored cluster"
"${compose[@]}" run --rm --no-deps backup run drill 2>&1 | sed 's/^/  /' \
  || fail "drill.sh failed"

cat <<EOF

=== ROUND TRIP PASSED ===
  rows restored          : $got / $expected  (exact match)
  last write before loss : $last_write
  same row after restore : $got_last
  recovered via WAL only : $(( expected_after + expected_timeout )) rows written after the last full backup
EOF
