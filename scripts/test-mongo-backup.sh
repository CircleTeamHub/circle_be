#!/usr/bin/env bash
# End-to-end proof for the chat-history (Mongo) backup path.
#
# scripts/test-backup-restore.sh covers Postgres and objects. This covers the
# third store — every chat message in the product — which is the one whose
# failures are hardest to notice, because nothing downstream breaks when the
# dump stops working.
#
# What it proves, in order:
#   1. A dump round-trips: seed Mongo -> backup-mongo.sh -> decrypt with the age
#      PRIVATE key -> mongorestore into a second database -> compare documents.
#      Proves the archive is real, encrypted to the right recipient, and
#      restorable — not merely that an object of some size appeared.
#   2. A FAILED dump leaves NOTHING behind. mongodump dying still lets `age`
#      emit a structurally valid archive wrapping zero bytes, which `mc pipe`
#      would upload; restore-mongo.sh without --key picks the newest object
#      under mongo/, so that empty archive is exactly what a real restore would
#      choose. This is the highest-severity finding from the review.
#   3. check.sh fails on a stale dump, and stays quiet when the mongo job was
#      never enabled. A freshness check that cannot fire is not a check.
#
# It runs the REAL artifacts: docker/backup/Dockerfile and deploy/backup/*.sh,
# driven through `run mongo` / `run check` exactly as cron would. A local MinIO
# over TLS stands in for R2/S3, and a throwaway mongod stands in for OpenIM's.
# Nothing outside the circle-mongo-drill-$$ project is touched.
#
# Usage: scripts/test-mongo-backup.sh
set -euo pipefail

project="circle-mongo-drill-$$"
tmp_env="tmp/mongo-test-$$.env"
tmp_override="tmp/mongo-test-$$.yml"
certs_dir="tmp/mongo-test-certs-$$"
keys_dir="tmp/mongo-test-keys-$$"

compose=(docker compose -p "$project"
         -f docker-compose.prod.yml
         -f docker-compose.backup.yml
         -f "$tmp_override")

# docker-compose.prod.yml interpolates these; only backup/mongo/backup-s3 ever start.
export DB_PASSWORD=test-only-db-password
export MINIO_ROOT_USER=test-only-minio
export MINIO_ROOT_PASSWORD=test-only-minio-password
export API_DOMAIN=api.example.test
export ADMIN_DOMAIN=admin.example.test
export ACME_EMAIL=ops@example.test
export OPENIM_NETWORK="definitely-not-a-real-network-$$"

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_env" "$tmp_override" "$certs_dir" "$keys_dir"
}
trap cleanup EXIT INT TERM

mkdir -p tmp
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { printf '\n=== %s\n' "$*"; }

s3_key="mongodrill"
s3_secret="$(openssl rand -hex 20)"
mongo_user="drilluser"
mongo_pass="$(openssl rand -hex 16)"

# pgBackRest is not involved here, but the destination is shared with the rest of
# the system and lib.sh requires https:// for it, so the stand-in serves real TLS.
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

  # Stands in for OpenIM's mongod. Same shape: auth on, standalone (no --replSet),
  # which is exactly why chat-history RPO equals the dump interval.
  mongo:
    image: mongo:7
    environment:
      MONGO_INITDB_ROOT_USERNAME: $mongo_user
      MONGO_INITDB_ROOT_PASSWORD: $mongo_pass
    healthcheck:
      test: ['CMD', 'mongosh', '--quiet', '--eval', 'db.adminCommand("ping")']
      interval: 3s
      timeout: 5s
      retries: 20

  # The mongo job is exercised through the "backup" service rather than the
  # profile-gated "backup_mongo": same image, same entrypoint, same
  # backup-mongo.sh, but on the default network so the test does not need a real
  # OpenIM stack or its external network.
  # (No backticks in this heredoc — it is unquoted, so they would be command
  # substitution and would silently blank out whatever they wrap.)
  backup:
    env_file: !override
      - $tmp_env
    depends_on:
      backup-s3: { condition: service_healthy }
      mongo: { condition: service_healthy }

  # Neither of these is started here, but compose validates env_file paths for
  # EVERY service while parsing — including profile-gated ones — so the
  # operator's real .env.backup would otherwise become a hard requirement for
  # running this test. Point them at the test env too.
  postgres:
    env_file: !override
      - $tmp_env
  backup_mongo:
    env_file: !override
      - $tmp_env
EOF

# The env file has to exist BEFORE any compose command runs: the override points
# several services' env_file at this path, and compose validates env_file paths
# while parsing, long before it would execute anything. So write everything that
# is already known now, and append the age recipient once the keypair exists.
cat > "$tmp_env" <<EOF
BACKUP_S3_ENDPOINT=https://backup-s3:9000
BACKUP_S3_INSECURE_TLS=1
BACKUP_S3_REGION=us-east-1
BACKUP_S3_BUCKET=circle-backup-test
BACKUP_S3_KEY=$s3_key
BACKUP_S3_KEY_SECRET=$s3_secret
BACKUP_PG_CIPHER_PASS=unused-here-but-required-by-lib
BACKUP_MONGO_URI=mongodb://$mongo_user:$mongo_pass@mongo:27017/openim_v3?authSource=admin
EOF

# Prove the merged configuration actually resolves before doing anything slow.
# Two distinct ways the generated files can be wrong, both of which used to
# surface three steps later as a misleading "age-keygen failed":
#   * the override is written by an UNQUOTED heredoc, so backticks and $(...)
#     inside it execute and can silently blank out lines;
#   * compose validates env_file paths for EVERY service, including ones this
#     test never starts, so missing a single !override leaves the operator's
#     real .env.backup as a hard requirement for running the test.
# `config -q` catches both, and whatever the next mistake turns out to be.
if ! cfg_err="$("${compose[@]}" config -q 2>&1)"; then
  printf '%s\n' "$cfg_err" | sed 's/^/  /' >&2
  fail "the generated compose configuration does not resolve"
fi

# ── age keypair (generated per run; the private key never leaves tmp/) ─────────
mkdir -p "$keys_dir"
step "0. building the backup image and generating an age keypair"
if ! build_out="$("${compose[@]}" build backup 2>&1)"; then
  printf '%s\n' "$build_out" >&2
  fail "image build failed"
fi
# age-keygen writes the keypair to stdout and ALSO echoes the public key to
# stderr. Capture stderr separately rather than discarding it, or a real failure
# here looks identical to a successful run that produced nothing.
if ! "${compose[@]}" run --rm --no-deps -T backup age-keygen \
       > "$keys_dir/age.key" 2>"$keys_dir/keygen.err"; then
  sed 's/^/  /' "$keys_dir/keygen.err" >&2
  fail "age-keygen failed"
fi
age_recipient="$(sed -n 's/^# public key: //p' "$keys_dir/age.key")"
[ -n "$age_recipient" ] \
  || { sed 's/^/  /' "$keys_dir/keygen.err" >&2; fail "could not read the age public key out of the generated keyfile"; }
printf 'BACKUP_AGE_RECIPIENT=%s\n' "$age_recipient" >> "$tmp_env"
echo "  recipient: $age_recipient"

# Run an arbitrary command in the backup image with the destination alias set up.
in_backup() { "${compose[@]}" run --rm --no-deps -T backup bash -c "$1"; }
mongo_objects() {
  in_backup '. /opt/backup/lib.sh && mc_alias_destination && mc ls --recursive "backup/${BACKUP_S3_BUCKET}/mongo/" 2>/dev/null | wc -l' \
    | tr -d '[:space:]'
}

step "1. starting the S3 stand-in + bucket, and a throwaway mongod"
if ! up_out="$("${compose[@]}" up -d backup-s3 mongo 2>&1)"; then
  printf '%s\n' "$up_out" >&2
  fail "stack did not start"
fi
for _ in $(seq 1 60); do
  [ "$("${compose[@]}" ps mongo --format '{{.Health}}' 2>/dev/null)" = healthy ] && break
  sleep 1
done
[ "$("${compose[@]}" ps mongo --format '{{.Health}}' 2>/dev/null)" = healthy ] \
  || { "${compose[@]}" logs --tail 30 mongo >&2; fail "mongo never became healthy"; }

# Create the destination bucket from the backup image itself rather than a
# separate init service: every `run` below uses --no-deps (to avoid dragging in
# postgres), which would skip a depends_on-gated initialiser and leave the
# bucket missing — a failure that only surfaces as an upload error much later.
in_backup '. /opt/backup/lib.sh && mc_alias_destination && mc mb --ignore-existing "backup/${BACKUP_S3_BUCKET}"' \
  >/dev/null 2>&1 || fail "could not create the destination bucket"
echo "  destination bucket ready"

step "2. check.sh must stay QUIET when no dump has ever run"
# A profile-gated job that was never enabled must not raise an alarm — otherwise
# every deployment without OpenIM screams once an hour and the check gets muted.
quiet_out="$(in_backup '/opt/backup/check.sh 2>&1' || true)"
printf '%s\n' "$quiet_out" | grep -q 'skip mongo' \
  || { printf '%s\n' "$quiet_out" | sed 's/^/  /' >&2; fail "check.sh did not skip the mongo check on an empty prefix"; }
printf '%s\n' "$quiet_out" | grep -q 'FAIL mongo' \
  && fail "check.sh raised a mongo alarm before any dump existed"
echo "  check.sh skipped the mongo check, as it should"

step "3. seeding the throwaway mongod"
"${compose[@]}" exec -T mongo mongosh "mongodb://$mongo_user:$mongo_pass@localhost:27017/admin" \
  --quiet --eval '
    db = db.getSiblingDB("openim_v3");
    db.msg.drop();
    const docs = [];
    for (let i = 0; i < 500; i++) docs.push({ _id: i, text: "message-" + i, seq: i });
    db.msg.insertMany(docs);
    print("seeded " + db.msg.countDocuments() + " documents");
  ' | sed 's/^/  /' || fail "could not seed mongo"

step "4. running the REAL backup job (deploy/backup/backup-mongo.sh)"
"${compose[@]}" run --rm --no-deps -T backup run mongo 2>&1 | sed 's/^/  /' \
  || fail "mongo backup failed"

count_after_good="$(mongo_objects)"
[ "$count_after_good" = "1" ] \
  || fail "expected exactly 1 object under mongo/ after a good dump, found $count_after_good"
echo "  objects under mongo/: $count_after_good"

step "5. ROUND TRIP — decrypt with the private key and restore into a second db"
# This is the part that proves the archive is genuinely restorable, rather than
# merely present and plausibly sized. Decrypt + restore happen inside the backup
# image (it carries age and mongorestore), targeting a DIFFERENT database so the
# comparison means something.
#
# The private key reaches the container base64-encoded through the command line
# and lands in /run, which is tmpfs — it never touches disk and never becomes a
# mount. Fine for a throwaway key generated seconds ago for this run alone.
identity_b64="$(base64 < "$keys_dir/age.key" | tr -d '\n')"
verify_out="$(in_backup "
  set -e
  . /opt/backup/lib.sh && mc_alias_destination
  echo '$identity_b64' | base64 -d > /run/age.key && chmod 600 /run/age.key
  key=\"\$(mc ls --recursive \"backup/\${BACKUP_S3_BUCKET}/mongo/\" | awk '{print \$NF}' | sort | tail -1)\"
  printf 'uri: \"%s\"\n' \"\$BACKUP_MONGO_URI\" > /run/r.conf && chmod 600 /run/r.conf
  mc cat \"backup/\${BACKUP_S3_BUCKET}/mongo/\${key#mongo/}\" \
    | age --decrypt -i /run/age.key \
    | mongorestore --config=/run/r.conf --archive --gzip \
        --nsFrom 'openim_v3.*' --nsTo 'restored_v3.*' 2>&1
  echo RESTORE_OK
")" || { printf '%s\n' "$verify_out" | sed 's/^/  /' >&2; fail "decrypt + mongorestore failed"; }
# Always show what mongorestore actually did — "0 document(s) restored" is a
# successful exit, so a silent success proves nothing.
printf '%s\n' "$verify_out" | grep -iE 'document|namespace|restoring|finished' | sed 's/^/    /' || true
printf '%s\n' "$verify_out" | grep -q RESTORE_OK \
  || { printf '%s\n' "$verify_out" | sed 's/^/  /' >&2; fail "restore did not complete"; }

restored="$("${compose[@]}" exec -T mongo mongosh \
  "mongodb://$mongo_user:$mongo_pass@localhost:27017/admin" --quiet --eval '
    print(db.getSiblingDB("restored_v3").msg.countDocuments());
  ' | tr -d '[:space:]')"
[ "$restored" = "500" ] || fail "restored document count mismatch: expected 500, got $restored"
echo "  restored documents: $restored / 500 (exact match)"

step "6. FAILED dump must leave NOTHING behind"
# The review finding: mongodump dying still lets age emit a valid archive of zero
# bytes, which mc pipe uploads and restore-mongo.sh would then select as "newest".
before="$(mongo_objects)"
bad_out="$("${compose[@]}" run --rm --no-deps -T \
  -e BACKUP_MONGO_URI="mongodb://$mongo_user:definitely-the-wrong-password@mongo:27017/admin" \
  backup run mongo 2>&1 || true)"
printf '%s\n' "$bad_out" | tail -3 | sed 's/^/  /'
printf '%s\n' "$bad_out" | grep -qiE 'fatal|fail' \
  || fail "a dump with bad credentials did not report failure"

after="$(mongo_objects)"
[ "$after" = "$before" ] \
  || fail "a FAILED dump left an object behind: mongo/ went from $before to $after objects — restore-mongo.sh would pick it"
echo "  objects under mongo/: $before before, $after after — nothing left behind"

step "7. check.sh must FAIL on a stale dump"
stale_out="$(in_backup 'BACKUP_CHECK_MONGO_MAX_AGE=1s /opt/backup/check.sh 2>&1' || true)"
printf '%s\n' "$stale_out" | grep -q 'FAIL mongo' \
  || { printf '%s\n' "$stale_out" | sed 's/^/  /' >&2; fail "check.sh did NOT fail on a stale chat-history dump"; }
echo "  check.sh reported the stale dump:"
printf '%s\n' "$stale_out" | grep 'mongo' | head -2 | sed 's/^/    /'

step "8. check.sh must PASS on a fresh dump"
fresh_out="$(in_backup 'BACKUP_CHECK_MONGO_MAX_AGE=24h /opt/backup/check.sh 2>&1' || true)"
printf '%s\n' "$fresh_out" | grep -q 'OK  mongo' \
  || { printf '%s\n' "$fresh_out" | sed 's/^/  /' >&2; fail "check.sh did not accept a fresh dump"; }
printf '%s\n' "$fresh_out" | grep 'mongo' | head -2 | sed 's/^/    /'

cat <<EOF

=== MONGO PATH PASSED ===
  round trip             : 500 / 500 documents, decrypted with the age private key
  failed dump            : left 0 objects behind (the empty-archive bug stays fixed)
  stale-dump alarm       : fires
  never-enabled job      : stays quiet
EOF
