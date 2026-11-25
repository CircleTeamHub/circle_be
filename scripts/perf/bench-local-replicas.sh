#!/usr/bin/env bash
# 本机多实例压测：起 N 个后端实例（各自一个目录、一个端口，共用数据库和 Redis），
# 把用户轮流分到各实例上，用 G 个发压进程分片发压，量吞吐、延迟和每个实例的 CPU。
# 用法：bench-local-replicas.sh <实例数> "<发送间隔毫秒> ..." [时长秒]
# 环境：PERF_INST_DIR（含 inst1..instN 的目录）、PERF_ACCOUNTS（令牌文件）、PERF_CLIENT_ROOT（见 load-chat.cjs）、
#       PERF_GENERATORS（发压进程数，默认 3）、PERF_USERS_TOTAL（默认 600）、PERF_REDIS_PORT（默认 56379）
# 每个 instK 目录要有自己的 .env.development（端口 320K），并软链 dist src node_modules tsconfig*.json
# package.json prisma —— 端口是从 cwd 下的 env 文件读的，环境变量覆盖不了。
set -uo pipefail
N="$1"; STEPS="$2"; DURATION="${3:-40}"
HERE="$(cd "$(dirname "$0")" && pwd)"
INST="${PERF_INST_DIR:?需要 PERF_INST_DIR}"; ACCOUNTS="${PERF_ACCOUNTS:?需要 PERF_ACCOUNTS}"
GENERATORS="${PERF_GENERATORS:-3}"; USERS_TOTAL="${PERF_USERS_TOTAL:-600}"; PER_GEN=$((USERS_TOTAL / GENERATORS))
OUT="${PERF_OUT:-${TMPDIR:-/tmp}/circle-perf-results}/local-replicas"; mkdir -p "$OUT"
secs() { ps -o time= -p "$1" 2>/dev/null | awk -F'[:.]' '{ n=NF; s=$(n-1)+$(n)/100; if (n>=3) s+=$(n-2)*60; if (n>=4) s+=$(n-3)*3600; printf "%.2f", s }'; }
# 只算连着压测库的数据库后端进程（别的会话也可能在本机开着临时库）。
pg_secs() { ps -axo time=,command= | awk '/postgres: .*circle_perf/ { split($1,t,/[:.]/); n=length(t); s=t[n-1]+t[n]/100; if (n>=3) s+=t[n-2]*60; total+=s } END { printf "%.2f", total }'; }

URLS=""; PIDS=""
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
redis-cli -p "${PERF_REDIS_PORT:-56379}" flushall >/dev/null
for i in $(seq 1 "$N"); do
  (cd "$INST/inst$i" && NODE_ENV=development exec node dist/src/main.js > "$INST/inst$i/server.log" 2>&1) &
  URLS="${URLS:+$URLS,}http://127.0.0.1:320$i"
done
for i in $(seq 1 "$N"); do
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:320$i/healthz")" = 200 ] && break; sleep 1; done
  pid=$(lsof -nP -iTCP:"320$i" -sTCP:LISTEN -t | head -1); [ -n "$pid" ] || { echo "实例 $i 没起来"; exit 1; }
  PIDS="$PIDS $pid"
done
node "$HERE/load-chat.cjs" --url "$URLS" --accounts "$ACCOUNTS" --users 120 --interval-ms 2000 --duration-s 12 --ramp-s 4 --label warmup >/dev/null 2>&1
sleep 2

for interval in $STEPS; do
  label="n${N}-i${interval}"
  declare -a C0=(); for p in $PIDS; do C0+=("$(secs "$p")"); done; P0=$(pg_secs)
  T0=$(date +%s)
  gens=""
  for g in $(seq 0 $((GENERATORS - 1))); do
    node "$HERE/load-chat.cjs" --url "$URLS" --accounts "$ACCOUNTS" --users "$PER_GEN" --offset $((g * PER_GEN)) \
      --interval-ms "$interval" --duration-s "$DURATION" --ramp-s 10 --label "$label-g$g" ${PERF_EXTRA:-} > "$OUT/$label-g$g.json" 2> "$OUT/$label-g$g.log" &
    gens="$gens $!"
  done
  wait $gens
  T1=$(date +%s)
  cpu=""; idx=0; for p in $PIDS; do c1=$(secs "$p"); cpu="$cpu $(echo "$c1 - ${C0[$idx]}" | bc)"; idx=$((idx + 1)); done; P1=$(pg_secs)
  node -e '
    const fs = require("fs"); const [out, label, gens, wall, pg, ...cpu] = process.argv.slice(1);
    const rs = Array.from({ length: Number(gens) }, (_, g) => JSON.parse(fs.readFileSync(`${out}/${label}-g${g}.json`, "utf8")));
    const sum = (k) => rs.reduce((a, r) => a + r[k], 0);
    const worst = (f) => Math.max(...rs.map(f).filter((v) => v !== null));
    const sent = sum("sent"), ok = sum("ackOk"), fail = sum("ackError") + sum("ackTimeout");
    const window = rs[0].durationS + 10; // 发压窗口 = 爬坡 + 稳态
    const codes = {}; rs.forEach((r) => Object.entries(r.ackErrorCodes).forEach(([k, v]) => (codes[k] = (codes[k] || 0) + v)));
    const cpuPct = cpu.map((c) => Math.round((Number(c) / Number(wall)) * 100));
    console.log(`${label}: 目标 ${sum("targetMsgPerSec").toFixed(0)}/s 实际确认 ${(ok / window).toFixed(0)}/s | 失败率 ${((fail / Math.max(sent, 1)) * 100).toFixed(1)}% ${JSON.stringify(codes)} 超时 ${sum("ackTimeout")} | 确认 p50/p95 ${worst((r) => r.ack.p50)}/${worst((r) => r.ack.p95)}ms 投递 p95 ${worst((r) => r.delivery.p95)}ms 收到 ${sum("delivered")} | 各实例 CPU% ${cpuPct.join("/")} 数据库 CPU ${Math.round((Number(pg) / Number(wall)) * 100)}% | 掉线 ${sum("disconnects")} 连接失败 ${sum("connectFailed")}`);
    if (fail / Math.max(sent, 1) > 0.05 || worst((r) => r.ack.p95) > 3000) process.exit(3);
  ' "$OUT" "$label" "$GENERATORS" "$((T1 - T0))" "$(echo "$P1 - $P0" | bc)" $cpu || { echo "  >>> 到达上限，停止加压"; break; }
  sleep 5
done
