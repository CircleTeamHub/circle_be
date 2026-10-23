#!/usr/bin/env bash
# deploy/backup/check.sh 的结果必须落成 Prometheus textfile —— 它原本只写容器
# stdout，备份坏了没有任何人会知道。这里用桩替换 pgbackrest / mc，逐项验证
# 写出的指标、失败语义不变，以及指标写不出去时检查本身不受影响。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
check="$repo_root/deploy/backup/check.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"

cat > "$fake_bin/pgbackrest" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *' check') [ "${STUB_PG_CHECK_FAIL:-0}" != "1" ] ;;
  *' info')
    if [ -n "${STUB_PG_NEWEST_STOP:-}" ]; then
      printf '[{"backup":[{"timestamp":{"start":1,"stop":%s}}]}]\n' "$STUB_PG_NEWEST_STOP"
    else
      printf '[{"backup":[]}]\n'
    fi
    ;;
  *) exit 64 ;;
esac
SH
cat > "$fake_bin/mc" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *' backup/'*) [ "${STUB_MC_DEST_FAIL:-0}" != "1" ] ;;
  *' source/'*) [ "${STUB_MC_SOURCE_FAIL:-0}" != "1" ] ;;
  *) exit 64 ;;
esac
SH
chmod +x "$fake_bin/pgbackrest" "$fake_bin/mc"

export PATH="$fake_bin:$PATH"
export BACKUP_S3_ENDPOINT=https://s3.example.test
export BACKUP_S3_BUCKET=offsite
export BACKUP_S3_KEY=key-id-not-a-metric
export BACKUP_S3_KEY_SECRET=secret-not-a-metric
export BACKUP_PG_CIPHER_PASS=cipher-not-a-metric
export BACKUP_MINIO_ENDPOINT=http://minio:9000
export BACKUP_MINIO_BUCKET=media
export BACKUP_MINIO_ACCESS_KEY=source-key-not-a-metric
export BACKUP_MINIO_SECRET_KEY=source-secret-not-a-metric

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# run_check <metrics dir> [VAR=value...] — prints the exit code.
run_check() {
  local dir="$1"; shift
  local rc=0
  env BACKUP_METRICS_DIR="$dir" "$@" bash "$check" >"$tmp_dir/out" 2>"$tmp_dir/err" || rc=$?
  printf '%s' "$rc"
}

assert_metric() {
  local file="$1" pattern="$2"
  grep -Eq "^${pattern}\$" "$file" || {
    cat "$file" >&2
    fail "expected a line matching ^${pattern}\$ in $file"
  }
}

now="$(date +%s)"

# ── 全部通过 ─────────────────────────────────────────────────────────────
dir="$tmp_dir/ok"; mkdir -p "$dir"
rc="$(run_check "$dir" STUB_PG_NEWEST_STOP=$((now - 3600)))"
[ "$rc" = 0 ] || fail "all-pass run exited $rc"
prom="$dir/backup_check.prom"
[ -f "$prom" ] || fail 'all-pass run wrote no backup_check.prom'
assert_metric "$prom" '# TYPE circle_backup_check_success gauge'
assert_metric "$prom" 'circle_backup_check_success\{check="postgres_archive"\} 1'
assert_metric "$prom" 'circle_backup_check_success\{check="backup_freshness"\} 1'
assert_metric "$prom" 'circle_backup_check_success\{check="destination_bucket"\} 1'
assert_metric "$prom" 'circle_backup_check_success\{check="minio_source"\} 1'
assert_metric "$prom" '# TYPE circle_backup_check_last_run_timestamp_seconds gauge'
stamp="$(sed -n 's/^circle_backup_check_last_run_timestamp_seconds \([0-9]*\)$/\1/p' "$prom")"
[ -n "$stamp" ] && [ "$stamp" -ge "$now" ] && [ "$stamp" -le $((now + 60)) ] \
  || fail "last-run timestamp '$stamp' is not the time of this run"
# 原子替换：node-exporter 只读 *.prom，临时文件不能残留，也不能是 *.prom。
[ "$(find "$dir" -type f | wc -l | tr -d ' ')" = 1 ] || { ls -la "$dir" >&2; fail 'temporary files left behind'; }
if grep -q -e 'not-a-metric' "$prom"; then fail 'a credential leaked into the metrics file'; fi

# ── 归档失败 + 源桶不可读：失败退出码不变，逐项标 0 ─────────────────────────
dir="$tmp_dir/fail"; mkdir -p "$dir"
rc="$(run_check "$dir" STUB_PG_CHECK_FAIL=1 STUB_MC_SOURCE_FAIL=1 STUB_PG_NEWEST_STOP=$((now - 3600)))"
[ "$rc" = 1 ] || fail "failing run exited $rc, want 1"
prom="$dir/backup_check.prom"
assert_metric "$prom" 'circle_backup_check_success\{check="postgres_archive"\} 0'
assert_metric "$prom" 'circle_backup_check_success\{check="destination_bucket"\} 1'
assert_metric "$prom" 'circle_backup_check_success\{check="minio_source"\} 0'

# ── 最新备份超过 48 小时 ────────────────────────────────────────────────
dir="$tmp_dir/stale"; mkdir -p "$dir"
rc="$(run_check "$dir" STUB_PG_NEWEST_STOP=$((now - 72 * 3600)))"
[ "$rc" = 1 ] || fail "stale-backup run exited $rc, want 1"
assert_metric "$dir/backup_check.prom" 'circle_backup_check_success\{check="backup_freshness"\} 0'

# ── 仓库里还没有任何备份：维持原语义（只警告不判失败），也不导出这一项 ──────
dir="$tmp_dir/empty"; mkdir -p "$dir"
rc="$(run_check "$dir")"
[ "$rc" = 0 ] || fail "empty-repo run exited $rc, want 0"
if grep -q 'check="backup_freshness"' "$dir/backup_check.prom"; then
  fail 'freshness must not be reported when no backup exists yet'
fi

# ── 没配源 MinIO：不导出 minio_source ───────────────────────────────────
dir="$tmp_dir/nosource"; mkdir -p "$dir"
rc="$(run_check "$dir" BACKUP_MINIO_ENDPOINT= STUB_PG_NEWEST_STOP=$((now - 3600)))"
[ "$rc" = 0 ] || fail "no-source run exited $rc, want 0"
if grep -q 'check="minio_source"' "$dir/backup_check.prom"; then
  fail 'minio_source must not be reported when the mirror is not configured'
fi

# ── 指标目录写不进去：检查结果与退出码不受影响，但要明确警告 ───────────────
touch "$tmp_dir/not-a-dir"
rc="$(run_check "$tmp_dir/not-a-dir/metrics" STUB_PG_NEWEST_STOP=$((now - 3600)))"
[ "$rc" = 0 ] || fail "unwritable-metrics run exited $rc, want 0"
grep -q 'could not write backup metrics' "$tmp_dir/err" || { cat "$tmp_dir/err" >&2; fail 'no warning for unwritable metrics dir'; }

printf 'backup-check-metrics: all assertions passed\n'
