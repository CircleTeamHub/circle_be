#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$PROJECT_ROOT/deploy/release-force-command.sh"
CASE_DIR="$(mktemp -d "$PROJECT_ROOT/.tmp-release-test.XXXXXX")"
DEPLOY_ROOT="$CASE_DIR/circle_be"
DEPLOY_HOME="$CASE_DIR/deploy-home"
STATE_DIR="$DEPLOY_ROOT/.release"
LOG="$STATE_DIR/activation.log"
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
IMAGE=ghcr.io/circleteamhub/circle_be@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
trap 'rm -rf "$CASE_DIR"' EXIT

mkdir -p "$STATE_DIR" "$DEPLOY_HOME" "$CASE_DIR/source/deploy"
printf 'payload\n' > "$CASE_DIR/source/VERSION"
printf '#!/usr/bin/env bash\n' > "$CASE_DIR/source/deploy/release-deploy.sh"
tar -C "$CASE_DIR/source" -czf "$CASE_DIR/stage.tar.gz" .
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$CASE_DIR/signing.pem" >/dev/null 2>&1
openssl pkey -in "$CASE_DIR/signing.pem" -pubout -out "$CASE_DIR/signing.pub" >/dev/null 2>&1
chmod 0400 "$CASE_DIR/signing.pem"
chmod 0444 "$CASE_DIR/signing.pub"

cat > "$STATE_DIR/release-launcher.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'stage=%s\n' "$1"
  printf 'schema=%s\n' "$TARGET_SCHEMA_COMPATIBILITY"
  printf 'tag=%s\n' "$RELEASE_TAG"
  printf 'image=%s\n' "$CIRCLE_BE_IMAGE"
  printf 'downtime=%s\n' "$RELEASE_DOWNTIME"
  printf 'irreversible=%s\n' "$RELEASE_IRREVERSIBLE_MIGRATION"
  printf 'user=%s\n' "$GHCR_USER"
  printf 'token=%s\n' "$GHCR_TOKEN"
  printf 'home=%s\n' "$HOME"
} > "$RELEASE_STATE_DIR/activation.log"
LAUNCHER
chmod 0555 "$STATE_DIR/release-launcher.sh"

run_gate() {
  local command="$1"
  HOME="$DEPLOY_HOME" SSH_ORIGINAL_COMMAND="$command" bash "$GATE" "$DEPLOY_ROOT" "$CASE_DIR/signing.pub"
}

sign_stage() {
  local stage="$1" archive="$2" manifest signature
  local digest
  manifest="$CASE_DIR/$stage.manifest"
  signature="$CASE_DIR/$stage.sig"
  digest="$(sha256sum "$archive" | awk '{print $1}')"
  printf '%s\n' 'version=1' "stage=$stage" "source_sha=${stage##*-}" \
    "archive_sha256=$digest" 'release_tag=v1.2.3' "image=$IMAGE" \
    'schema=0' 'downtime=0' 'irreversible=0' > "$manifest"
  openssl dgst -sha256 -sign "$CASE_DIR/signing.pem" -out "$signature" "$manifest"
  printf '%s %s\n' "$(base64 -w0 "$manifest")" "$(base64 -w0 "$signature")"
}

stage_archive() {
  local stage="$1" archive="$2" manifest_b64 signature_b64
  read -r manifest_b64 signature_b64 < <(sign_stage "$stage" "$archive")
  run_gate "circle-release stage-v2 $stage $manifest_b64 $signature_b64" < "$archive"
}

activate_stage() {
  local stage="$1" tag="${2:-v1.2.3}"
  printf '%s\n' 0 "$tag" "$IMAGE" 0 0 'github-actions[bot]' test-token |
    run_gate "circle-release activate-v2 $stage"
}

STAGE="123-1-$SHA"
stage_archive "$STAGE" "$CASE_DIR/stage.tar.gz"
[ "$(cat "$STATE_DIR/incoming/$STAGE/VERSION")" = payload ]
[ "$(cat "$STATE_DIR/incoming/$STAGE/.release-source-sha")" = "$SHA" ]
[ -s "$STATE_DIR/incoming/$STAGE/.release-manifest" ]
[ -s "$STATE_DIR/incoming/$STAGE/.release-manifest.sig" ]
activate_stage "$STAGE"
grep -q '^stage=123-1-' "$LOG"
grep -q '^tag=v1.2.3$' "$LOG"
grep -Fqx "home=$DEPLOY_HOME" "$LOG"

KEEP_STAGE="124-1-$SHA"
stage_archive "$KEEP_STAGE" "$CASE_DIR/stage.tar.gz"
chmod 0755 "$STATE_DIR/release-launcher.sh"
if activate_stage "$KEEP_STAGE" >"$CASE_DIR/untrusted.log" 2>&1; then
  echo 'unexpectedly activated through a deploy-account-writable launcher' >&2
  exit 1
fi
[ -d "$STATE_DIR/incoming/$KEEP_STAGE" ]
chmod 0555 "$STATE_DIR/release-launcher.sh"

MISMATCH_STAGE="125-1-$SHA"
stage_archive "$MISMATCH_STAGE" "$CASE_DIR/stage.tar.gz"
if activate_stage "$MISMATCH_STAGE" v9.9.9 >"$CASE_DIR/mismatch.log" 2>&1; then
  echo 'unexpectedly activated with unsigned payload values' >&2
  exit 1
fi
grep -Fq 'activation tag does not match signed manifest' "$CASE_DIR/mismatch.log"

read -r MANIFEST_B64 SIGNATURE_B64 < <(sign_stage "126-1-$SHA" "$CASE_DIR/stage.tar.gz")
if run_gate "circle-release stage-v2 126-1-$SHA $MANIFEST_B64 AAAA" < "$CASE_DIR/stage.tar.gz" >"$CASE_DIR/signature.log" 2>&1; then
  echo 'unexpectedly accepted an invalid signature' >&2
  exit 1
fi
grep -Fq 'release manifest signature verification failed' "$CASE_DIR/signature.log"

expect_stage_rejected() {
  local stage="$1" archive="$2" expected="$3" manifest_b64 signature_b64
  read -r manifest_b64 signature_b64 < <(sign_stage "$stage" "$archive")
  if run_gate "circle-release stage-v2 $stage $manifest_b64 $signature_b64" < "$archive" >"$CASE_DIR/rejected-stage.log" 2>&1; then
    echo "unexpectedly staged rejected archive: $stage" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$CASE_DIR/rejected-stage.log"; then
    cat "$CASE_DIR/rejected-stage.log" >&2
    exit 1
  fi
  [ ! -e "$STATE_DIR/incoming/$stage" ]
}

printf 'checking per-file expanded size limit\n'
node "$PROJECT_ROOT/test/create-sized-tar.cjs" "$CASE_DIR/too-large.tar.gz" 134217729
expect_stage_rejected "127-1-$SHA" "$CASE_DIR/too-large.tar.gz" 'archive file exceeds expanded size limit'

printf 'checking total expanded size limit\n'
node "$PROJECT_ROOT/test/create-sized-tar.cjs" "$CASE_DIR/too-expanded.tar.gz" \
  125000000 125000000 125000000 125000000 125000000 \
  125000000 125000000 125000000 125000000
expect_stage_rejected "128-1-$SHA" "$CASE_DIR/too-expanded.tar.gz" 'archive exceeds total expanded size limit'

printf 'checking archive entry limit\n'
if [ "${OS:-}" = 'Windows_NT' ]; then
  printf 'SKIP 10,001-entry tar traversal on Windows Git Bash\n'
else
  node "$PROJECT_ROOT/test/create-many-entry-tar.cjs" "$CASE_DIR/too-many.tar.gz" 10001
  expect_stage_rejected "129-1-$SHA" "$CASE_DIR/too-many.tar.gz" 'archive contains too many entries'
fi

printf 'checking special file rejection\n'
node "$PROJECT_ROOT/test/create-many-entry-tar.cjs" "$CASE_DIR/special-file.tar.gz" 1 link
expect_stage_rejected "130-1-$SHA" "$CASE_DIR/special-file.tar.gz" 'archive contains unsupported file type'

for rejected in 'bash -s' 'circle-release stage old' \
  "circle-release activate $KEEP_STAGE" \
  "circle-release stage-v2 ../../escape $MANIFEST_B64 $SIGNATURE_B64"; do
  if run_gate "$rejected" </dev/null >"$CASE_DIR/rejected.log" 2>&1; then
    echo "unexpectedly accepted command: $rejected" >&2
    exit 1
  fi
done

printf 'PASS signed release protocol and archive resource bounds\n'
