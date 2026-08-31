#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT

fail() {
  echo "FAIL $*" >&2
  exit 1
}

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

file_inode() {
  stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1"
}

prepare_case() {
  local name="$1" root
  root="$CASE_DIR/$name"
  mkdir -p "$root/deploy"
  cp "$ROOT_DIR/deploy/gen-env.sh" "$root/deploy/"
  cat > "$root/.env" <<EOF
DB_PASSWORD=test-db
MINIO_ROOT_USER=test-minio
MINIO_ROOT_PASSWORD=test-secret
APP_ENV_GID=$(id -g)
EOF
  cat > "$root/.env.production" <<'EOF'
DATABASE_URL=postgres://test
REDIS_URL="redis://default:old@redis:6379"
ALLOWED_ORIGINS=https://old.example.test
MINIO_ENDPOINT=http://minio:9000
EOF
  chmod 600 "$root/.env" "$root/.env.production"
}

run_gen_env() {
  local root="$1"
  (
    cd "$root"
    bash deploy/gen-env.sh 203.0.113.10 api.example.test admin.example.test \
        ops@example.test web.example.test
  )
}

prepare_case success
chmod 640 "$CASE_DIR/success/.env.production"
run_gen_env "$CASE_DIR/success"
[ "$(file_mode "$CASE_DIR/success/.env.production")" = "640" ] || fail "rerun widened protected config"
grep -q 'https://admin.example.test' "$CASE_DIR/success/.env.production" || fail "rerun did not update config"
echo "PASS already-migrated existing config remains protected during rerun"

prepare_case failure
legacy_inode="$(file_inode "$CASE_DIR/failure/.env.production")"
legacy_content="$(cat "$CASE_DIR/failure/.env.production")"
if run_gen_env "$CASE_DIR/failure" >"$CASE_DIR/failure.log" 2>&1; then
  fail "legacy config permissions unexpectedly changed in place"
fi
[ "$(file_inode "$CASE_DIR/failure/.env.production")" = "$legacy_inode" ] || fail "refusal replaced the legacy inode"
[ "$(file_mode "$CASE_DIR/failure/.env.production")" = "600" ] || fail "refusal changed mode 0600"
[ "$(cat "$CASE_DIR/failure/.env.production")" = "$legacy_content" ] || fail "refusal changed legacy config content"
grep -q '请先走 Release 工作流' "$CASE_DIR/failure.log" || fail "refusal did not explain the safe migration path"
echo "PASS legacy existing config fails closed without changing inode, mode, or content"
