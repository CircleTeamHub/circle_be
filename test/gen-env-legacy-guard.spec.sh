#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CASE_DIR="$(mktemp -d)"
trap 'rm -rf "$CASE_DIR"' EXIT
mkdir -p "$CASE_DIR/deploy" "$CASE_DIR/bin"
cp "$ROOT_DIR/deploy/gen-env.sh" "$CASE_DIR/deploy/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$CASE_DIR/bin/flock"
chmod +x "$CASE_DIR/bin/flock"

cat > "$CASE_DIR/.env" <<'EOF'
DB_PASSWORD=test-db
MINIO_ROOT_USER=test-minio
MINIO_ROOT_PASSWORD=test-secret
EOF
printf 'SECRET=legacy\n' > "$CASE_DIR/.env.production"
chmod 600 "$CASE_DIR/.env" "$CASE_DIR/.env.production"

file_inode() {
  stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1"
}

legacy_inode="$(file_inode "$CASE_DIR/.env.production")"
legacy_content="$(cat "$CASE_DIR/.env.production")"
if (
  cd "$CASE_DIR"
  PATH="$CASE_DIR/bin:$PATH" bash deploy/gen-env.sh 203.0.113.10 api.example.test admin.example.test \
    ops@example.test web.example.test
) >"$CASE_DIR/output.log" 2>&1; then
  echo "legacy config rewrite unexpectedly succeeded" >&2
  exit 1
fi

[ "$(file_inode "$CASE_DIR/.env.production")" = "$legacy_inode" ]
[ "$(cat "$CASE_DIR/.env.production")" = "$legacy_content" ]
[ "$(stat -c '%a' "$CASE_DIR/.env.production" 2>/dev/null || stat -f '%Lp' "$CASE_DIR/.env.production")" = "600" ]
grep -q '拒绝原地' "$CASE_DIR/output.log"
echo "PASS legacy gen-env rerun fails closed without changing production config"
