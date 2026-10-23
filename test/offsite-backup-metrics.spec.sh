#!/usr/bin/env bash
# 发版时的异地备份结果必须能进告警：之前它只打横幅、写 GitHub annotation 和
# ~/circle_be_backups/.offsite-status，没有任何东西在看。offsite_report 现在
# 还把结果写成 Prometheus textfile，经 docker exec 直接放进备份 overlay 的
# backup_metrics 卷（backup-metrics 导出，ReleaseOffsiteBackupFailed 读它）。
#
# 这里用桩替换 docker，在发版脚本同样的 set -euo pipefail 下逐项验证：
# 写出的指标、备份 overlay 没跑时的降级，以及任何 docker 失败都不能中断发版。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"

cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "${1:-}" in
  ps)
    [ "${STUB_PS_FAIL:-0}" != "1" ] || exit 1
    [ -z "${STUB_BACKUP_CID:-}" ] || printf '%s\n' "$STUB_BACKUP_CID"
    ;;
  exec)
    [ "${STUB_EXEC_FAIL:-0}" != "1" ] || exit 1
    [ "${STUB_EXEC_HANG:-0}" != "1" ] || exec sleep 60
    cat > "$EXEC_STDIN"
    ;;
  *) exit 64 ;;
esac
SH
chmod +x "$fake_bin/docker"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# run_report <case> <state> [VAR=value...] — sources the script exactly as
# release-deploy.sh does and calls offsite_report; prints the exit code.
run_report() {
  local name="$1" state="$2"; shift 2
  local dir="$tmp_dir/$name"
  mkdir -p "$dir"
  local rc=0
  env PATH="$fake_bin:$PATH" DOCKER_LOG="$dir/docker.log" EXEC_STDIN="$dir/stdin" "$@" \
    bash -c 'set -euo pipefail; . "$1/deploy/offsite-backup.sh"; offsite_report "$2" "$3" "detail for $3"; echo REACHED_END' \
    _ "$repo_root" "$dir" "$state" >"$dir/out" 2>"$dir/err" || rc=$?
  printf '%s' "$rc"
}

now="$(date +%s)"

# ── 失败：写 0 进卷，状态文件照旧 ───────────────────────────────────────
rc="$(run_report failed failed STUB_BACKUP_CID=cid-123)"
[ "$rc" = 0 ] || fail "failed report exited $rc"
grep -q REACHED_END "$tmp_dir/failed/out" || fail 'offsite_report aborted the caller under set -e'
grep -q '^failed ' "$tmp_dir/failed/.offsite-status" || fail '.offsite-status not written'
grep -q -- '--filter label=com.docker.compose.project=circle-be' "$tmp_dir/failed/docker.log" || fail 'backup container not looked up by compose project'
grep -q -- '--filter label=com.docker.compose.service=backup' "$tmp_dir/failed/docker.log" || fail 'backup container not looked up by service'
grep -q '^exec -i cid-123 ' "$tmp_dir/failed/docker.log" || { cat "$tmp_dir/failed/docker.log" >&2; fail 'metric not written through docker exec into the backup container'; }
grep -q '/var/lib/circle-backup/metrics' "$tmp_dir/failed/docker.log" || fail 'metric not written into the backup_metrics volume path'
grep -q '^# TYPE circle_release_offsite_backup_success gauge$' "$tmp_dir/failed/stdin" || fail 'missing TYPE line'
grep -q '^circle_release_offsite_backup_success 0$' "$tmp_dir/failed/stdin" || { cat "$tmp_dir/failed/stdin" >&2; fail 'failed state not exported as 0'; }
stamp="$(sed -n 's/^circle_release_offsite_backup_timestamp_seconds \([0-9]*\)$/\1/p' "$tmp_dir/failed/stdin")"
[ -n "$stamp" ] && [ "$stamp" -ge "$now" ] && [ "$stamp" -le $((now + 60)) ] || fail "timestamp '$stamp' is not the time of this report"
if grep -q 'detail for' "$tmp_dir/failed/stdin"; then fail 'free-form failure detail leaked into the metric'; fi

# ── 成功：写 1 ─────────────────────────────────────────────────────────
rc="$(run_report ok ok STUB_BACKUP_CID=cid-123)"
[ "$rc" = 0 ] || fail "ok report exited $rc"
grep -q '^circle_release_offsite_backup_success 1$' "$tmp_dir/ok/stdin" || fail 'ok state not exported as 1'

# ── 项目名可覆盖（与 monitoring/docker-compose.logs.yml 同一个变量）─────
rc="$(run_report project ok STUB_BACKUP_CID=cid-9 CIRCLE_BE_PROJECT_NAME=preprod)"
[ "$rc" = 0 ] || fail "custom project report exited $rc"
grep -q -- '--filter label=com.docker.compose.project=preprod' "$tmp_dir/project/docker.log" || fail 'CIRCLE_BE_PROJECT_NAME ignored'

# ── 备份 overlay 没在跑：只降级提示，不执行 exec，发版照常 ─────────────────
rc="$(run_report nooverlay failed)"
[ "$rc" = 0 ] || fail "no-overlay report exited $rc"
grep -q REACHED_END "$tmp_dir/nooverlay/out" || fail 'no-overlay case aborted the caller'
if grep -q '^exec ' "$tmp_dir/nooverlay/docker.log"; then fail 'exec attempted without a backup container'; fi
grep -q 'backup overlay is not running' "$tmp_dir/nooverlay/err" || { cat "$tmp_dir/nooverlay/err" >&2; fail 'no hint that the result will not alert'; }

# ── docker ps / exec 失败：同样不能中断发版 ─────────────────────────────
rc="$(run_report psfail failed STUB_PS_FAIL=1)"
[ "$rc" = 0 ] || fail "docker ps failure exited $rc"
grep -q REACHED_END "$tmp_dir/psfail/out" || fail 'docker ps failure aborted the caller'

rc="$(run_report execfail failed STUB_BACKUP_CID=cid-123 STUB_EXEC_FAIL=1)"
[ "$rc" = 0 ] || fail "docker exec failure exited $rc"
grep -q REACHED_END "$tmp_dir/execfail/out" || fail 'docker exec failure aborted the caller'
grep -q 'could not publish' "$tmp_dir/execfail/err" || fail 'no warning when publishing the metric failed'

# ── docker exec 卡住：有 timeout 时必须在超时后返回，发版不能被它拖住 ─────────
if command -v timeout >/dev/null 2>&1; then
  started="$(date +%s)"
  rc="$(run_report hang failed STUB_BACKUP_CID=cid-123 STUB_EXEC_HANG=1 BACKUP_OFFSITE_METRIC_TIMEOUT_SECONDS=1)"
  [ "$rc" = 0 ] || fail "hung docker exec exited $rc"
  [ $(( $(date +%s) - started )) -lt 20 ] || fail 'a hung docker exec held up the release'
  grep -q REACHED_END "$tmp_dir/hang/out" || fail 'hung docker exec aborted the caller'
  grep -q 'could not publish' "$tmp_dir/hang/err" || fail 'no warning when publishing timed out'
else
  printf 'offsite-backup-metrics: no timeout(1) here, skipping the hang case\n'
fi

printf 'offsite-backup-metrics: all assertions passed\n'
