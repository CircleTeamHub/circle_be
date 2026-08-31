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
  mkdir -p "$root/deploy" "$root/bin"
  cp "$ROOT_DIR/deploy/gen-env.sh" "$root/deploy/"
  cat > "$root/bin/flock" <<'EOF'
#!/usr/bin/env bash
[ "${LOCK_FAIL:-0}" != "1" ]
EOF
  chmod +x "$root/bin/flock"
  cat > "$root/.env" <<EOF
DB_PASSWORD=test-db
MINIO_ROOT_USER=test-minio
MINIO_ROOT_PASSWORD=test-secret
APP_ENV_GID=$(id -g)
REDIS_PASSWORD=legacy-password
EOF
  cat > "$root/.env.production" <<'EOF'
DATABASE_URL=postgres://test
REDIS_URL="redis://default:legacy-password@redis:6379"
ALLOWED_ORIGINS=https://old.example.test
MINIO_ENDPOINT=http://minio:9000
METRICS_AUTH_TOKEN=short-existing-token
EOF
  chmod 600 "$root/.env" "$root/.env.production"
}

run_gen_env() {
  local root="$1" lock_fail="${2:-0}"
  (
    cd "$root"
    PATH="$root/bin:$PATH" \
      LOCK_FAIL="$lock_fail" \
      RELEASE_STATE_DIR="$root/.release" \
      bash deploy/gen-env.sh 203.0.113.10 api.example.test admin.example.test \
      ops@example.test web.example.test
  )
}

run_gen_env_with_real_lock() {
  local root="$1"
  (
    cd "$root"
    RELEASE_STATE_DIR="$root/.release" \
      bash deploy/gen-env.sh 203.0.113.10 api.example.test admin.example.test \
      ops@example.test web.example.test
  )
}

prepare_case success
chmod 640 "$CASE_DIR/success/.env.production"
if command -v setfacl >/dev/null && command -v getfacl >/dev/null && id nobody >/dev/null 2>&1; then
  setfacl -m u:nobody:r "$CASE_DIR/success/.env" "$CASE_DIR/success/.env.production"
fi
run_gen_env "$CASE_DIR/success"
[ "$(file_mode "$CASE_DIR/success/.env.production")" = "640" ] || fail "rerun widened protected config"
grep -q 'https://admin.example.test' "$CASE_DIR/success/.env.production" || fail "rerun did not update config"
grep -q '^REDIS_PASSWORD=legacy-password$' "$CASE_DIR/success/.env" || fail "rerun rotated a non-hex Redis password"
grep -q '^REDIS_URL="redis://default:legacy-password@redis:6379"$' "$CASE_DIR/success/.env.production" || fail "rerun rewrote the live Redis credential"
grep -q '^METRICS_AUTH_TOKEN=short-existing-token$' "$CASE_DIR/success/.env.production" || fail "rerun rotated an existing metrics token"
if command -v getfacl >/dev/null; then
  ! getfacl -cp "$CASE_DIR/success/.env" | grep -q '^user:nobody:' || fail "rerun retained a named ACL on .env"
  ! getfacl -cp "$CASE_DIR/success/.env.production" | grep -q '^user:nobody:' || fail "rerun retained a named ACL on .env.production"
fi
echo "PASS already-migrated existing config remains protected during rerun"

prepare_case locked
chmod 640 "$CASE_DIR/locked/.env.production"
locked_env="$(cat "$CASE_DIR/locked/.env")"
locked_app_env="$(cat "$CASE_DIR/locked/.env.production")"
if run_gen_env "$CASE_DIR/locked" 1 >"$CASE_DIR/locked.log" 2>&1; then
  fail "rerun ignored the shared release lock"
fi
[ "$(cat "$CASE_DIR/locked/.env")" = "$locked_env" ] || fail "lock refusal mutated .env"
[ "$(cat "$CASE_DIR/locked/.env.production")" = "$locked_app_env" ] || fail "lock refusal mutated .env.production"
grep -q '另一个发版或配置更新正在进行' "$CASE_DIR/locked.log" || {
  cat "$CASE_DIR/locked.log" >&2
  fail "lock refusal was not actionable"
}
echo "PASS existing rerun fails closed while a release holds the shared lock"

if command -v flock >/dev/null; then
  prepare_case real_lock
  chmod 640 "$CASE_DIR/real_lock/.env.production"
  real_lock_env="$(cat "$CASE_DIR/real_lock/.env")"
  real_lock_app_env="$(cat "$CASE_DIR/real_lock/.env.production")"
  exec 9>/tmp/circle-be-release.lock
  flock -n 9 || fail "could not acquire shared release lock for test"
  if run_gen_env_with_real_lock "$CASE_DIR/real_lock" >"$CASE_DIR/real_lock.log" 2>&1; then
    fail "rerun did not contend on the release lock path"
  fi
  [ "$(cat "$CASE_DIR/real_lock/.env")" = "$real_lock_env" ] || fail "real lock refusal mutated .env"
  [ "$(cat "$CASE_DIR/real_lock/.env.production")" = "$real_lock_app_env" ] || fail "real lock refusal mutated .env.production"
  flock -u 9
  run_gen_env_with_real_lock "$CASE_DIR/real_lock" >/dev/null
  echo "PASS existing rerun uses the exact shared release lock path"
fi

prepare_case transaction
chmod 640 "$CASE_DIR/transaction/.env.production"
mkdir -p "$CASE_DIR/transaction/.release/app-env-transaction"
printf 'cutover-pending:circle_be_green:circle_be\n' > "$CASE_DIR/transaction/.release/app-env-transaction/state"
transaction_env="$(cat "$CASE_DIR/transaction/.env")"
transaction_app_env="$(cat "$CASE_DIR/transaction/.env.production")"
if run_gen_env "$CASE_DIR/transaction" >"$CASE_DIR/transaction.log" 2>&1; then
  fail "rerun ignored an unfinished app env transaction"
fi
[ "$(cat "$CASE_DIR/transaction/.env")" = "$transaction_env" ] || fail "transaction refusal mutated .env"
[ "$(cat "$CASE_DIR/transaction/.env.production")" = "$transaction_app_env" ] || fail "transaction refusal mutated .env.production"
grep -q '未完成的 app env 事务' "$CASE_DIR/transaction.log" || fail "transaction refusal was not actionable"
echo "PASS existing rerun fails closed during app env recovery"

prepare_case missing_metrics
chmod 640 "$CASE_DIR/missing_metrics/.env.production"
grep -v '^METRICS_AUTH_TOKEN=' "$CASE_DIR/missing_metrics/.env.production" > "$CASE_DIR/missing_metrics/app-env.tmp"
mv "$CASE_DIR/missing_metrics/app-env.tmp" "$CASE_DIR/missing_metrics/.env.production"
chmod 640 "$CASE_DIR/missing_metrics/.env.production"
run_gen_env "$CASE_DIR/missing_metrics" >"$CASE_DIR/missing_metrics.log" 2>&1
grep -Eq '^METRICS_AUTH_TOKEN=.{32,}$' "$CASE_DIR/missing_metrics/.env.production" || fail "rerun did not generate a missing metrics token"
test -e "$CASE_DIR/missing_metrics/.release/metrics-token-sync-required" || fail "missing metrics token did not persist a sync marker"
grep -q 'monitoring/sync-metrics-token.sh' "$CASE_DIR/missing_metrics.log" || fail "new metrics token did not print the required sync action"
grep -q '重新创建 Prometheus' "$CASE_DIR/missing_metrics.log" || fail "new metrics token did not warn about the Prometheus restart"
run_gen_env "$CASE_DIR/missing_metrics" >"$CASE_DIR/missing_metrics-rerun.log" 2>&1
grep -q '监控 token 仍待同步' "$CASE_DIR/missing_metrics-rerun.log" || fail "pending metrics sync did not survive a rerun"
echo "PASS missing metrics token generation prints the required consumer sync"

prepare_case placeholder_metrics
chmod 640 "$CASE_DIR/placeholder_metrics/.env.production"
sed 's/^METRICS_AUTH_TOKEN=.*/METRICS_AUTH_TOKEN="__REPLACE_RANDOM__"/' \
  "$CASE_DIR/placeholder_metrics/.env.production" > "$CASE_DIR/placeholder_metrics/app-env.tmp"
mv "$CASE_DIR/placeholder_metrics/app-env.tmp" "$CASE_DIR/placeholder_metrics/.env.production"
chmod 640 "$CASE_DIR/placeholder_metrics/.env.production"
run_gen_env "$CASE_DIR/placeholder_metrics" >/dev/null 2>&1
! grep -q '__REPLACE_RANDOM__' "$CASE_DIR/placeholder_metrics/.env.production" || fail "placeholder metrics token was preserved"
test -e "$CASE_DIR/placeholder_metrics/.release/metrics-token-sync-required" || fail "placeholder replacement did not persist a sync marker"
echo "PASS placeholder metrics token is replaced with a recoverable sync requirement"

prepare_case missing_url
chmod 640 "$CASE_DIR/missing_url/.env.production"
grep -v '^REDIS_URL=' "$CASE_DIR/missing_url/.env.production" > "$CASE_DIR/missing_url/app-env.tmp"
mv "$CASE_DIR/missing_url/app-env.tmp" "$CASE_DIR/missing_url/.env.production"
chmod 640 "$CASE_DIR/missing_url/.env.production"
run_gen_env "$CASE_DIR/missing_url" >/dev/null 2>&1
grep -q '^REDIS_PASSWORD=legacy-password$' "$CASE_DIR/missing_url/.env" || fail "missing URL rotated the existing password"
grep -q '^REDIS_URL="redis://default:legacy-password@redis:6379"$' "$CASE_DIR/missing_url/.env.production" || fail "missing URL was not filled from the existing password"
echo "PASS missing bundled Redis URL is filled without rotation"

prepare_case missing_both
chmod 640 "$CASE_DIR/missing_both/.env.production"
grep -v '^REDIS_PASSWORD=' "$CASE_DIR/missing_both/.env" > "$CASE_DIR/missing_both/compose.tmp"
mv "$CASE_DIR/missing_both/compose.tmp" "$CASE_DIR/missing_both/.env"
grep -v '^REDIS_URL=' "$CASE_DIR/missing_both/.env.production" > "$CASE_DIR/missing_both/app-env.tmp"
mv "$CASE_DIR/missing_both/app-env.tmp" "$CASE_DIR/missing_both/.env.production"
chmod 600 "$CASE_DIR/missing_both/.env"
chmod 640 "$CASE_DIR/missing_both/.env.production"
run_gen_env "$CASE_DIR/missing_both" >/dev/null 2>&1
generated_password="$(sed -n 's/^REDIS_PASSWORD=//p' "$CASE_DIR/missing_both/.env")"
printf '%s' "$generated_password" | grep -Eq '^[a-f0-9]{48}$' || fail "missing Redis credentials did not generate a safe password"
grep -q "^REDIS_URL=\"redis://default:$generated_password@redis:6379\"$" "$CASE_DIR/missing_both/.env.production" || fail "generated Redis credentials do not match"
echo "PASS fully missing bundled Redis credentials are generated as a matching pair"

for refusal in missing_password mismatched_password; do
  prepare_case "$refusal"
  chmod 640 "$CASE_DIR/$refusal/.env.production"
  if [ "$refusal" = "missing_password" ]; then
    grep -v '^REDIS_PASSWORD=' "$CASE_DIR/$refusal/.env" > "$CASE_DIR/$refusal/compose.tmp"
  else
    sed 's/^REDIS_PASSWORD=.*/REDIS_PASSWORD=other-password/' "$CASE_DIR/$refusal/.env" > "$CASE_DIR/$refusal/compose.tmp"
  fi
  mv "$CASE_DIR/$refusal/compose.tmp" "$CASE_DIR/$refusal/.env"
  chmod 600 "$CASE_DIR/$refusal/.env"
  refusal_env="$(cat "$CASE_DIR/$refusal/.env")"
  refusal_app_env="$(cat "$CASE_DIR/$refusal/.env.production")"
  if run_gen_env "$CASE_DIR/$refusal" >/dev/null 2>&1; then
    fail "$refusal Redis configuration unexpectedly succeeded"
  fi
  [ "$(cat "$CASE_DIR/$refusal/.env")" = "$refusal_env" ] || fail "$refusal refusal mutated .env"
  [ "$(cat "$CASE_DIR/$refusal/.env.production")" = "$refusal_app_env" ] || fail "$refusal refusal mutated .env.production"
done
echo "PASS missing and inconsistent bundled Redis passwords fail without mutation"

prepare_case special_missing_url
chmod 640 "$CASE_DIR/special_missing_url/.env.production"
sed 's/^REDIS_PASSWORD=.*/REDIS_PASSWORD="p#ss"/' "$CASE_DIR/special_missing_url/.env" > "$CASE_DIR/special_missing_url/compose.tmp"
mv "$CASE_DIR/special_missing_url/compose.tmp" "$CASE_DIR/special_missing_url/.env"
grep -v '^REDIS_URL=' "$CASE_DIR/special_missing_url/.env.production" > "$CASE_DIR/special_missing_url/app-env.tmp"
mv "$CASE_DIR/special_missing_url/app-env.tmp" "$CASE_DIR/special_missing_url/.env.production"
chmod 600 "$CASE_DIR/special_missing_url/.env"
chmod 640 "$CASE_DIR/special_missing_url/.env.production"
if run_gen_env "$CASE_DIR/special_missing_url" >"$CASE_DIR/special_missing_url.log" 2>&1; then
  fail "special-character password was interpolated into a Redis URL"
fi
grep -q 'percent-encoded REDIS_URL' "$CASE_DIR/special_missing_url.log" || fail "special password refusal was not actionable"
echo "PASS special-character password requires an explicit encoded Redis URL"

prepare_case encoded_url
chmod 640 "$CASE_DIR/encoded_url/.env.production"
sed 's/^REDIS_PASSWORD=.*/REDIS_PASSWORD="p#ss"/' "$CASE_DIR/encoded_url/.env" > "$CASE_DIR/encoded_url/compose.tmp"
mv "$CASE_DIR/encoded_url/compose.tmp" "$CASE_DIR/encoded_url/.env"
sed 's#^REDIS_URL=.*#REDIS_URL="redis://default:p%23ss@redis:6379"#' "$CASE_DIR/encoded_url/.env.production" > "$CASE_DIR/encoded_url/app-env.tmp"
mv "$CASE_DIR/encoded_url/app-env.tmp" "$CASE_DIR/encoded_url/.env.production"
chmod 600 "$CASE_DIR/encoded_url/.env"
chmod 640 "$CASE_DIR/encoded_url/.env.production"
run_gen_env "$CASE_DIR/encoded_url" >/dev/null 2>&1
grep -q '^REDIS_URL="redis://default:p%23ss@redis:6379"$' "$CASE_DIR/encoded_url/.env.production" || fail "encoded Redis URL was rewritten"
echo "PASS percent-encoded bundled Redis URL matches the dotenv password"

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
