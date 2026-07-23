#!/usr/bin/env bash
# End-to-end proof for the object (MinIO) backup path.
#
# Third of three: test-backup-restore.sh covers Postgres+WAL, test-mongo-backup.sh
# covers chat history, this covers user media — avatars, chat attachments, note
# media. Until this existed, backup-minio.sh and restore-minio.sh had never been
# executed once, in any test.
#
# What it proves, in order:
#   1. The mirror actually copies objects off-host, with byte-identical content
#      (checksums, not object counts — a truncated copy has the right name).
#   2. DELETES DO NOT PROPAGATE. The mirror runs without --remove and without
#      --overwrite specifically so that an attacker holding the app's MinIO
#      credentials cannot destroy the backup by destroying the source. That is
#      the property standing in for the object versioning R2 does not offer, and
#      it is the one claim in docs/backups.md that was pure assertion.
#   3. A restore brings the objects back, byte-identical, after the source bucket
#      has been emptied entirely.
#   4. --dry-run writes nothing.
#
# Runs the REAL artifacts: docker/backup/Dockerfile, deploy/backup/backup-minio.sh
# and restore-minio.sh, driven through `run minio` exactly as cron would. The
# app's own MinIO (from docker-compose.prod.yml) is the source; a second MinIO
# over TLS stands in for R2/S3. Nothing outside circle-minio-drill-$$ is touched.
#
# Usage: scripts/test-minio-backup.sh
set -euo pipefail

project="circle-minio-drill-$$"
tmp_env="tmp/minio-test-$$.env"
tmp_override="tmp/minio-test-$$.yml"
certs_dir="tmp/minio-test-certs-$$"

compose=(docker compose -p "$project"
         -f docker-compose.prod.yml
         -f docker-compose.backup.yml
         -f "$tmp_override")

export DB_PASSWORD=test-only-db-password
export MINIO_ROOT_USER=test-only-minio
export MINIO_ROOT_PASSWORD=test-only-minio-password
export API_DOMAIN=api.example.test
export ADMIN_DOMAIN=admin.example.test
export ACME_EMAIL=ops@example.test
export OPENIM_NETWORK="definitely-not-a-real-network-$$"

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_env" "$tmp_override" "$certs_dir"
}
trap cleanup EXIT INT TERM

mkdir -p tmp
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { printf '\n=== %s\n' "$*"; }

s3_key="miniodrill"
s3_secret="$(openssl rand -hex 20)"

mkdir -p "$certs_dir"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$certs_dir/private.key" -out "$certs_dir/public.crt" \
  -subj "/CN=backup-s3" -addext "subjectAltName=DNS:backup-s3" >/dev/null 2>&1 \
  || fail "could not generate a self-signed cert for the test destination"
chmod 644 "$certs_dir/private.key"

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
    healthcheck:
      test: ['CMD', 'curl', '-sk', '--max-time', '5', '-o', '/dev/null', 'https://127.0.0.1:9000/minio/health/live']
      interval: 3s
      timeout: 5s
      retries: 20

  # The app's own MinIO is the SOURCE. Drop the published console port: the test
  # never needs it, and binding 127.0.0.1:9001 would collide with a real stack
  # running on this machine.
  minio:
    ports: !override []

  backup:
    env_file: !override
      - $tmp_env
    depends_on:
      backup-s3: { condition: service_healthy }
      minio: { condition: service_healthy }

  # Not started, but compose validates env_file for every service while parsing.
  postgres:
    env_file: !override
      - $tmp_env
  backup_mongo:
    env_file: !override
      - $tmp_env
EOF

cat > "$tmp_env" <<EOF
BACKUP_S3_ENDPOINT=https://backup-s3:9000
BACKUP_S3_INSECURE_TLS=1
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=circle-backup-test
BACKUP_S3_KEY=$s3_key
BACKUP_S3_KEY_SECRET=$s3_secret
BACKUP_PG_CIPHER_PASS=unused-here-but-required-by-lib
BACKUP_MINIO_ENDPOINT=http://minio:9000
BACKUP_MINIO_ACCESS_KEY=$MINIO_ROOT_USER
BACKUP_MINIO_SECRET_KEY=$MINIO_ROOT_PASSWORD
BACKUP_MINIO_BUCKET=circle
EOF

if ! cfg_err="$("${compose[@]}" config -q 2>&1)"; then
  printf '%s\n' "$cfg_err" | sed 's/^/  /' >&2
  fail "the generated compose configuration does not resolve"
fi

# Run a command in the backup image with BOTH aliases configured.
in_backup() { "${compose[@]}" run --rm --no-deps -T backup bash -c "$1"; }
with_aliases='. /opt/backup/lib.sh && mc_alias_source && mc_alias_destination'

step "0. building the backup image"
if ! build_out="$("${compose[@]}" build backup 2>&1)"; then
  printf '%s\n' "$build_out" >&2
  fail "image build failed"
fi

step "1. starting the source MinIO and the off-host stand-in"
if ! up_out="$("${compose[@]}" up -d minio backup-s3 2>&1)"; then
  printf '%s\n' "$up_out" >&2
  fail "stack did not start"
fi
for _ in $(seq 1 60); do
  [ "$("${compose[@]}" ps minio --format '{{.Health}}' 2>/dev/null)" = healthy ] \
    && [ "$("${compose[@]}" ps backup-s3 --format '{{.Health}}' 2>/dev/null)" = healthy ] && break
  sleep 1
done
[ "$("${compose[@]}" ps minio --format '{{.Health}}' 2>/dev/null)" = healthy ] \
  || { "${compose[@]}" logs --tail 30 minio >&2; fail "source minio never became healthy"; }

in_backup "$with_aliases && mc mb --ignore-existing source/\${BACKUP_MINIO_BUCKET} && mc mb --ignore-existing backup/\${BACKUP_S3_BUCKET}" \
  >/dev/null 2>&1 || fail "could not create the buckets"
echo "  source and destination buckets ready"

# ── the fixture ───────────────────────────────────────────────────────────────
# Keys mirror the real layout from src/upload/upload.service.ts:
# <folder>/<userId>/<uuid>.<ext>
step "2. seeding the source bucket with known objects"
seed_out="$(in_backup "
  set -e
  $with_aliases
  mkdir -p /run/seed
  head -c 20000 /dev/urandom > /run/seed/avatar.bin
  head -c 50000 /dev/urandom > /run/seed/attachment.bin
  head -c 3000  /dev/urandom > /run/seed/note.bin
  mc cp --quiet /run/seed/avatar.bin     source/\${BACKUP_MINIO_BUCKET}/avatars/u1/a.jpg    >/dev/null
  mc cp --quiet /run/seed/attachment.bin source/\${BACKUP_MINIO_BUCKET}/chat/u2/b.png       >/dev/null
  mc cp --quiet /run/seed/note.bin       source/\${BACKUP_MINIO_BUCKET}/notes/u3/c.pdf      >/dev/null
  echo 'SEEDED'
  mc cat source/\${BACKUP_MINIO_BUCKET}/avatars/u1/a.jpg | md5sum | cut -d' ' -f1
  mc cat source/\${BACKUP_MINIO_BUCKET}/chat/u2/b.png    | md5sum | cut -d' ' -f1
  mc cat source/\${BACKUP_MINIO_BUCKET}/notes/u3/c.pdf   | md5sum | cut -d' ' -f1
")" || { printf '%s\n' "$seed_out" | sed 's/^/  /' >&2; fail "could not seed the source bucket"; }
printf '%s\n' "$seed_out" | grep -q SEEDED || fail "seeding did not complete"
md5_avatar="$(printf '%s\n' "$seed_out" | grep -A3 SEEDED | sed -n '2p' | tr -d '[:space:]')"
md5_chat="$(printf   '%s\n' "$seed_out" | grep -A3 SEEDED | sed -n '3p' | tr -d '[:space:]')"
md5_note="$(printf   '%s\n' "$seed_out" | grep -A3 SEEDED | sed -n '4p' | tr -d '[:space:]')"
[ -n "$md5_avatar" ] && [ -n "$md5_chat" ] && [ -n "$md5_note" ] \
  || fail "could not read the source checksums"
echo "  3 objects seeded (avatars/ chat/ notes/), checksums recorded"

step "3. running the REAL mirror job (deploy/backup/backup-minio.sh)"
"${compose[@]}" run --rm --no-deps -T backup run minio 2>&1 | sed 's/^/  /' \
  || fail "minio mirror failed"

step "4. the copies must be byte-identical, not merely present"
verify_out="$(in_backup "
  set -e
  $with_aliases
  p=backup/\${BACKUP_S3_BUCKET}/minio/\${BACKUP_MINIO_BUCKET}
  echo COUNT=\$(mc ls --recursive \$p | wc -l | tr -d ' ')
  echo A=\$(mc cat \$p/avatars/u1/a.jpg | md5sum | cut -d' ' -f1)
  echo B=\$(mc cat \$p/chat/u2/b.png    | md5sum | cut -d' ' -f1)
  echo C=\$(mc cat \$p/notes/u3/c.pdf   | md5sum | cut -d' ' -f1)
")" || { printf '%s\n' "$verify_out" | sed 's/^/  /' >&2; fail "could not read the mirrored objects"; }
got_count="$(printf '%s\n' "$verify_out" | sed -n 's/^COUNT=//p' | tr -d '[:space:]')"
[ "$got_count" = "3" ] || fail "expected 3 mirrored objects, found $got_count"
for pair in "A:$md5_avatar" "B:$md5_chat" "C:$md5_note"; do
  k="${pair%%:*}"; want="${pair#*:}"
  got="$(printf '%s\n' "$verify_out" | sed -n "s/^$k=//p" | tr -d '[:space:]')"
  [ "$got" = "$want" ] || fail "mirrored object $k checksum mismatch: source=$want backup=$got"
done
echo "  3/3 objects mirrored, all checksums match the source"

step "5. DELETES MUST NOT PROPAGATE (the property replacing object versioning)"
# Simulate the app's MinIO credentials being used to destroy live data, then run
# the scheduled mirror again. The backup must be unaffected.
del_out="$(in_backup "
  set -e
  $with_aliases
  mc rm --quiet source/\${BACKUP_MINIO_BUCKET}/avatars/u1/a.jpg >/dev/null
  echo SRC_AFTER_DELETE=\$(mc ls --recursive source/\${BACKUP_MINIO_BUCKET} | wc -l | tr -d ' ')
")" || { printf '%s\n' "$del_out" | sed 's/^/  /' >&2; fail "could not delete from the source"; }
[ "$(printf '%s\n' "$del_out" | sed -n 's/^SRC_AFTER_DELETE=//p' | tr -d '[:space:]')" = "2" ] \
  || fail "the source delete did not take effect"

"${compose[@]}" run --rm --no-deps -T backup run minio 2>&1 | sed 's/^/    /' \
  || fail "the second mirror run failed"

after_out="$(in_backup "
  set -e
  $with_aliases
  p=backup/\${BACKUP_S3_BUCKET}/minio/\${BACKUP_MINIO_BUCKET}
  echo COUNT=\$(mc ls --recursive \$p | wc -l | tr -d ' ')
  echo A=\$(mc cat \$p/avatars/u1/a.jpg | md5sum | cut -d' ' -f1)
")" || { printf '%s\n' "$after_out" | sed 's/^/  /' >&2; fail "the deleted object is GONE from the backup"; }
[ "$(printf '%s\n' "$after_out" | sed -n 's/^COUNT=//p' | tr -d '[:space:]')" = "3" ] \
  || fail "backup lost an object after a source delete — deletes ARE propagating"
[ "$(printf '%s\n' "$after_out" | sed -n 's/^A=//p' | tr -d '[:space:]')" = "$md5_avatar" ] \
  || fail "the deleted object survived in name but its content changed"
echo "  source 2 objects, backup still 3 — the deleted object survives, byte-identical"

step "6. --dry-run must write nothing"
in_backup "
  set -e
  $with_aliases
  mc rm --recursive --force --quiet source/\${BACKUP_MINIO_BUCKET} >/dev/null 2>&1 || true
  echo emptied
" >/dev/null || fail "could not empty the source bucket"
in_backup "/opt/backup/restore-minio.sh --dry-run" >/dev/null 2>&1 \
  || fail "restore --dry-run exited non-zero"
dry_count="$(in_backup "$with_aliases && mc ls --recursive source/\${BACKUP_MINIO_BUCKET} | wc -l" | tr -d '[:space:]')"
[ "$dry_count" = "0" ] \
  || fail "--dry-run wrote $dry_count objects into the source bucket"
echo "  source still empty after --dry-run"

step "7. RESTORE — bring everything back into an emptied source bucket"
"${compose[@]}" run --rm --no-deps -T backup /opt/backup/restore-minio.sh 2>&1 | sed 's/^/  /' \
  || fail "restore-minio.sh failed"

restored_out="$(in_backup "
  set -e
  $with_aliases
  echo COUNT=\$(mc ls --recursive source/\${BACKUP_MINIO_BUCKET} | wc -l | tr -d ' ')
  echo A=\$(mc cat source/\${BACKUP_MINIO_BUCKET}/avatars/u1/a.jpg | md5sum | cut -d' ' -f1)
  echo B=\$(mc cat source/\${BACKUP_MINIO_BUCKET}/chat/u2/b.png    | md5sum | cut -d' ' -f1)
  echo C=\$(mc cat source/\${BACKUP_MINIO_BUCKET}/notes/u3/c.pdf   | md5sum | cut -d' ' -f1)
")" || { printf '%s\n' "$restored_out" | sed 's/^/  /' >&2; fail "could not read the restored objects"; }
[ "$(printf '%s\n' "$restored_out" | sed -n 's/^COUNT=//p' | tr -d '[:space:]')" = "3" ] \
  || fail "expected 3 restored objects, found $(printf '%s\n' "$restored_out" | sed -n 's/^COUNT=//p')"
for pair in "A:$md5_avatar" "B:$md5_chat" "C:$md5_note"; do
  k="${pair%%:*}"; want="${pair#*:}"
  got="$(printf '%s\n' "$restored_out" | sed -n "s/^$k=//p" | tr -d '[:space:]')"
  [ "$got" = "$want" ] || fail "restored object $k checksum mismatch: expected=$want got=$got"
done

cat <<EOF

=== OBJECT PATH PASSED ===
  mirror                 : 3 / 3 objects, checksums identical to source
  deletes propagate      : NO — source went to 2, backup stayed at 3
  --dry-run              : wrote nothing
  restore                : 3 / 3 objects back into an emptied bucket, byte-identical
EOF
