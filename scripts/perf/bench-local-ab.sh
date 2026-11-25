#!/usr/bin/env bash
# 本机对比压测：对一个已构建的后端工作区，跑一档固定负载，量「每条消息的后端 CPU」。
# 用法：bench-local-ab.sh <标签> <工作区目录> <端口> <用户数> [发送间隔毫秒] [时长秒]
# 前提：工作区已 nest build，.env.development 指向本机压测库和 Redis；令牌文件见 PERF_ACCOUNTS，
# socket.io-client 的来源见 PERF_CLIENT_ROOT（load-chat.cjs）。本机还要有对象存储在跑，否则后端卡在启动。
set -uo pipefail
LABEL="$1"; DIR="$2"; PORT="$3"; USERS="$4"; INTERVAL="${5:-5000}"; DURATION="${6:-60}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ACCOUNTS="${PERF_ACCOUNTS:?需要 PERF_ACCOUNTS}"
OUT="${PERF_OUT:-${TMPDIR:-/tmp}/circle-perf-results}/local-ab"; mkdir -p "$OUT"
secs() { ps -o time= -p "$1" | awk -F'[:.]' '{ n=NF; s=$(n-1)+$(n)/100; if (n>=3) s+=$(n-2)*60; if (n>=4) s+=$(n-3)*3600; printf "%.2f", s }'; }
pg_secs() { ps -axo time=,command= | awk '/[p]ostgres/ { split($1,t,/[:.]/); n=length(t); s=t[n-1]+t[n]/100; if (n>=3) s+=t[n-2]*60; total+=s } END { printf "%.2f", total }'; }

redis-cli -p "${PERF_REDIS_PORT:-56379}" flushall >/dev/null
(cd "$DIR" && NODE_ENV=development exec node dist/src/main.js > "$OUT/$LABEL.server.log" 2>&1) &
SERVER=$!
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$PORT/healthz")" = 200 ] && break; sleep 1; done
PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)
[ -n "$PID" ] || { echo "$LABEL: 后端没起来"; kill $SERVER 2>/dev/null; exit 1; }
# 预热：让 JIT 和连接池稳定下来，不计入测量。
node "$HERE/load-chat.cjs" --url "http://127.0.0.1:$PORT" --accounts "$ACCOUNTS" --users 60 --interval-ms 2000 --duration-s 15 --ramp-s 5 --label warmup >/dev/null 2>&1
sleep 2
C0=$(secs "$PID"); P0=$(pg_secs)
node "$HERE/load-chat.cjs" --url "http://127.0.0.1:$PORT" --accounts "$ACCOUNTS" --users "$USERS" --interval-ms "$INTERVAL" --duration-s "$DURATION" --ramp-s 10 --label "$LABEL" ${PERF_EXTRA:-} > "$OUT/$LABEL.json" 2> "$OUT/$LABEL.log"
C1=$(secs "$PID"); P1=$(pg_secs)
kill "$PID" 2>/dev/null; wait $SERVER 2>/dev/null
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const [c0, c1, p0, p1] = process.argv.slice(2).map(Number);
  const be = (c1 - c0) * 1000 / r.ackOk, pg = (p1 - p0) * 1000 / r.ackOk;
  console.log(`${r.label}: 目标 ${r.targetMsgPerSec}/s 确认 ${r.ackOk}/${r.sent} 超时 ${r.ackTimeout} 错误 ${r.ackError} | 确认延迟 p50/p95 ${r.ack.p50}/${r.ack.p95}ms | 后端 CPU ${(c1 - c0).toFixed(1)}s = ${be.toFixed(2)}ms/条 | 数据库 CPU ${(p1 - p0).toFixed(1)}s = ${pg.toFixed(2)}ms/条 | 拉列表 ${r.list.ok} 次`);
' "$OUT/$LABEL.json" "$C0" "$C1" "$P0" "$P1"
