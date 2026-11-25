#!/usr/bin/env bash
# 阶梯加压：每一档跑 load-chat.cjs，并在稳态中段从服务器取一次资源快照。
# 用法：run-load-steps.sh "<用户数>:<发送间隔毫秒> ..."   例如 "50:5000 100:5000 200:5000"
# 需要先开好到后端容器的 SSH 隧道（127.0.0.1:13100）。
# 环境变量：
#   PERF_ACCOUNTS     令牌文件（seed-perf-load.cjs 的输出），必填
#   PERF_CLIENT_ROOT  装有 socket.io-client 的目录，必填（见 load-chat.cjs）
#   PERF_SSH          取资源快照用的 SSH 目标，如 ubuntu@<测试服地址>，必填
#   PERF_SSH_KEY      SSH 私钥路径，可选
#   PERF_HEALTH_URL   每档开始前探测的公网健康检查地址，必填；不通就停止加压
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ACCOUNTS="${PERF_ACCOUNTS:?需要 PERF_ACCOUNTS}"
SSH_TARGET="${PERF_SSH:?需要 PERF_SSH}"
HEALTH_URL="${PERF_HEALTH_URL:?需要 PERF_HEALTH_URL}"
URL="${PERF_URL:-http://127.0.0.1:13100}"
DURATION="${PERF_DURATION_S:-90}"
RAMP="${PERF_RAMP_S:-20}"
OUT="${PERF_OUT:-${TMPDIR:-/tmp}/circle-perf-results}/load-$(date +%m%d-%H%M)"
mkdir -p "$OUT"

rsh() { ssh ${PERF_SSH_KEY:+-i "$PERF_SSH_KEY" -o IdentitiesOnly=yes} -o ConnectTimeout=15 -o BatchMode=yes "$SSH_TARGET" "$@"; }

snapshot() {
  rsh '
    be=$(docker ps --format "{{.Names}}" | grep -E "^circle-be-(blue|green)$" | head -1)
    docker stats --no-stream --format "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}" "$be" circle-be-postgres-1 circle-be-redis-1 | tr "\n" ";"
    echo
    echo "host load=$(cut -d" " -f1-3 /proc/loadavg) sshd_cpu=$(ps -C sshd -o %cpu= | awk "{s+=\$1} END{print s}")%"
    q() { docker exec circle-prometheus wget -qO- "http://localhost:9090/api/v1/query?query=$1" 2>/dev/null | sed -E "s/.*\"value\":\[[0-9.]+,\"([^\"]+)\"\].*/\1/; t; s/.*/n\/a/"; }
    echo "prom eventloop_p99_s=$(q nodejs_eventloop_lag_p99_seconds) db_pool_waiting=$(q circle_db_pool_waiting) db_pool_total=$(q circle_db_pool_total) chat_connections=$(q chat_connections_active) server_ack_p95_s=$(q "histogram_quantile(0.95%2Csum(rate(chat_message_ack_duration_seconds_bucket%5B1m%5D))by(le))") server_ack_p50_s=$(q "histogram_quantile(0.5%2Csum(rate(chat_message_ack_duration_seconds_bucket%5B1m%5D))by(le))")"
  ' 2>/dev/null
}

for step in $1; do
  users="${step%%:*}"; interval="${step##*:}"; label="u${users}-i${interval}${PERF_TAG:-}"
  health=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$HEALTH_URL")
  echo "=== $label 开始 $(date +%T) 公网健康检查=$health"
  if [ "$health" != "200" ]; then echo "健康检查不通过，停止加压"; break; fi
  node "$DIR/load-chat.cjs" --url "$URL" --accounts "$ACCOUNTS" --users "$users" --interval-ms "$interval" \
    --duration-s "$DURATION" --ramp-s "$RAMP" --label "$label" ${PERF_EXTRA:-} > "$OUT/$label.json" 2> "$OUT/$label.log" &
  load_pid=$!
  sleep $((RAMP + DURATION * 6 / 10))
  snapshot | tee "$OUT/$label.server.txt"
  wait "$load_pid"
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`结果 ${r.label}: 目标 ${r.targetMsgPerSec} 条/秒 | 结束时在线 ${r.connectedAtEnd}/${r.users} 连接失败 ${r.connectFailed} 掉线 ${r.disconnects} ${JSON.stringify(r.disconnectReasons)}`);
    console.log(`  发送 ${r.sent} 确认 ${r.ackOk} 错误 ${r.ackError} ${JSON.stringify(r.ackErrorCodes)} 超时 ${r.ackTimeout} 失败率 ${r.ackFailRate}%`);
    console.log(`  确认延迟 p50/p95/p99 = ${r.ack.p50}/${r.ack.p95}/${r.ack.p99} ms | 投递 ${r.delivered} 条 p50/p95/p99 = ${r.delivery.p50}/${r.delivery.p95}/${r.delivery.p99} ms`);
    console.log(`  会话列表 成功 ${r.list.ok} 失败 ${r.list.failed} ${JSON.stringify(r.list.status)} p50/p95 = ${r.list.p50}/${r.list.p95} ms | 建连 p50/p95 = ${r.connect.p50}/${r.connect.p95} ms`);
    if (r.ackFailRate > 5 || (r.ack.p95 ?? 0) > 3000) { console.log("  >>> 达到停止条件（失败率 > 5% 或确认 p95 > 3 秒）"); process.exit(3); }
  ' "$OUT/$label.json" || { echo "停止继续加压"; break; }
  sleep 15
done
echo "原始结果目录: $OUT"
