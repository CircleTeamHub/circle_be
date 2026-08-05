#!/usr/bin/env bash
# OpenIM 栈加固（#106/#107）。在服务器上、openim-docker 目录旁执行：
#
#   bash deploy/openim-harden.sh [openim-docker 路径，默认 ~/openim-docker]
#
# 做什么（幂等，全部只改文件、绝不重启容器）：
#   1. .env 里仍是上游公开默认值的密钥 → 换成强随机（OPENIM_SECRET / Mongo / Redis / MinIO）
#   2. etcd 的裸端口映射（12379/12380，不吃 HOST_BIND_IP 前缀）→ 钉到 127.0.0.1
#   3. Mongo/Redis/MinIO/Kafka 等基建端口映射 → 钉到 127.0.0.1
#      （msggateway 10001 / api 10002 默认保持对外 —— 测试期客户端直连）
#   4. 打印需要同步到 circle_be .env.production 的 OPENIM_ADMIN_SECRET 新值
#
# 最后一步收口（域名 + Caddy 就绪后执行一次）：
#
#   bash deploy/openim-harden.sh [openim-docker 路径] --collapse-public-ports
#
# 它把 10001/10002 也钉回环，并把 .env 的 HOST_BIND_IP 切成 127.0.0.1。收口之前，
# 客户端直连网关 = 完全绕过 Caddy，那边加的限流/连接上限一条都不生效（见
# deploy/Caddyfile.admin 的 rate_limit）。收口后客户端必须走 wss://<域名>/openim-ws。
#
# 改完后需要的重启（见 runbook，自行安排窗口）：
#   cd <openim-docker> && docker compose up -d --force-recreate
#   cd <circle_be>    && 更新 .env.production 后重启 app 容器
#
# 每个被改的文件都会留下 .bak.<时间戳> 备份；回滚 = 恢复备份 + 同样的重启。
set -euo pipefail
umask 077

COLLAPSE_PUBLIC_PORTS=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --collapse-public-ports) COLLAPSE_PUBLIC_PORTS=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

OPENIM_DIR="${ARGS[0]:-$HOME/openim-docker}"
ENV_FILE="$OPENIM_DIR/.env"
COMPOSE_FILE="$OPENIM_DIR/docker-compose.yaml"
[ -f "$COMPOSE_FILE" ] || COMPOSE_FILE="$OPENIM_DIR/docker-compose.yml"
STAMP="$(date +%Y%m%d%H%M%S)"

[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE" >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "找不到 $OPENIM_DIR/docker-compose.ya?ml" >&2; exit 1; }

gen() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

backup() {
  local f="$1"
  cp -p "$f" "$f.bak.$STAMP"
  echo "已备份: $f.bak.$STAMP"
}

# 把 .env 里 KEY 当前等于某个已知默认值时换成新随机值；已经是强值则不动（幂等）。
rotate_if_default() {
  local key="$1"; shift
  local current
  current="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$current" ]; then
    echo "跳过 ${key}: .env 中不存在"
    return
  fi
  local is_default=0
  for d in "$@"; do
    [ "$current" = "$d" ] && is_default=1
  done
  if [ "$is_default" = 1 ]; then
    local value
    value="$(gen)"
    sed -i.sedbak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "$ENV_FILE.sedbak"
    echo "已轮换 ${key}（原为上游公开默认值）"
    ROTATED_KEYS="$ROTATED_KEYS $key"
  else
    echo "保留 ${key}: 已不是上游默认值"
  fi
}

echo "== OpenIM 栈加固: $OPENIM_DIR =="
backup "$ENV_FILE"
backup "$COMPOSE_FILE"
ROTATED_KEYS=""

# ── 1. 密钥轮换（只动仍处于上游公开默认值的项）─────────────────────────────
# 上游 openim-docker 的公开默认值。任何能连到主机的人都查得到这些值。
rotate_if_default "OPENIM_SECRET"      "openIM123"
# round 3 review（P1）：MONGO_* 不能只改 .env —— 对已有数据卷，上游 compose
# 只在用户不存在时才按 env 建号，库里的旧密码原样保留；只改 .env 会让
# openim-server/chat 直接认证失败、IM 全断。Mongo 轮换必须两步走（先在库内
# 用旧凭据改密，再改 .env），脚本不代劳，只打印手工流程：
if grep -qE '^MONGO_PASSWORD=openIM123$|^MONGO_OPENIM_PASSWORD=openIM123$' "$ENV_FILE"; then
  echo "⚠ MONGO_PASSWORD / MONGO_OPENIM_PASSWORD 仍是默认值。不自动轮换（已有"
  echo "  数据卷时只改 .env 会把 IM 打断）。手工两步："
  echo "  1) docker exec -it <mongo容器> mongosh -u <user> -p openIM123 \\"
  echo '       --eval "db.getSiblingDB(\"admin\").changeUserPassword(\"<user>\", \"<新密码>\")"'
  echo "  2) 把新密码写进 $ENV_FILE 后再 force-recreate"
fi
rotate_if_default "REDIS_PASSWORD"     "openIM123"
rotate_if_default "MINIO_SECRET_ACCESS_KEY" "openIM123"

# ── 2. etcd 裸映射钉回环（#106 第三条：它不吃 HOST_BIND_IP 前缀）──────────────
# 匹配三种写法（review 修复：补上 ${HOST_BIND_IP}: 前缀形 —— openim-docker
# 部分版本这么写，而 .env 默认 HOST_BIND_IP=0.0.0.0，照样是公网暴露，此前
# 会漏进「未找到」分支只打警告）：
#   - "12379:2379"                     裸映射
#   - "${HOST_BIND_IP}:12379:2379"    变量前缀映射
#   - "127.0.0.1:12379:2379"          已钉好
patch_port() {
  local pub="$1" internal="$2"
  local var_prefix="\\\$\\{HOST_BIND_IP\\}:"
  if grep -qE "^[[:space:]]*-[[:space:]]*[\"']?${pub}:${internal}[\"']?[[:space:]]*$" "$COMPOSE_FILE"; then
    sed -i.sedbak -E "s|^([[:space:]]*-[[:space:]]*)[\"']?${pub}:${internal}[\"']?[[:space:]]*$|\1\"127.0.0.1:${pub}:${internal}\"|" "$COMPOSE_FILE" \
      && rm -f "$COMPOSE_FILE.sedbak"
    echo "已钉到回环: ${pub}:${internal}"
  elif grep -qE "^[[:space:]]*-[[:space:]]*[\"']?${var_prefix}${pub}:${internal}[\"']?[[:space:]]*$" "$COMPOSE_FILE"; then
    sed -i.sedbak -E "s|^([[:space:]]*-[[:space:]]*)[\"']?${var_prefix}${pub}:${internal}[\"']?[[:space:]]*$|\1\"127.0.0.1:${pub}:${internal}\"|" "$COMPOSE_FILE" \
      && rm -f "$COMPOSE_FILE.sedbak"
    echo "已钉到回环（原为 \${HOST_BIND_IP}: 前缀）: ${pub}:${internal}"
  elif grep -qE "127\.0\.0\.1:${pub}:${internal}" "$COMPOSE_FILE"; then
    echo "已是回环: ${pub}:${internal}"
  else
    echo "⚠ 未找到端口映射 ${pub}:${internal} —— 请人工确认 compose 里它的写法"
  fi
}
# 同 patch_port，但绑定地址可指定 —— 网关端口要绑 docker bridge 而不是回环
# （回环 = Caddy 容器连不上 = 收口即全站中断）。
# 注意分隔符：这里的正则含交替 / 任意前缀，绝不能再用 `|` 当 sed 分隔符
# （那样 sed 会把交替符当成分隔符，静默不替换，而 grep 检测照样通过 —— 脚本会
# 打印“已绑定”但文件一个字没改）。用 # 作分隔符。
pin_port_to() {
  local bind="$1" pub="$2" internal="$3"
  # 已经是目标绑定：幂等返回。
  if grep -qE "^[[:space:]]*-[[:space:]]*[\"']?${bind}:${pub}:${internal}[\"']?[[:space:]]*\$" "$COMPOSE_FILE"; then
    echo "已绑定 ${bind}: ${pub}:${internal}"
    return
  fi
  # 匹配任意前缀形式：裸 pub:internal、${HOST_BIND_IP}:pub:internal、a.b.c.d:pub:internal
  if grep -qE "^[[:space:]]*-[[:space:]]*[\"']?.*${pub}:${internal}[\"']?[[:space:]]*\$" "$COMPOSE_FILE"; then
    sed -i.sedbak -E "s#^([[:space:]]*-[[:space:]]*)[\"']?.*${pub}:${internal}[\"']?[[:space:]]*\$#\\1\"${bind}:${pub}:${internal}\"#" "$COMPOSE_FILE" \
      && rm -f "$COMPOSE_FILE.sedbak"
    echo "已绑定 ${bind}: ${pub}:${internal}"
  else
    echo "⚠ 未找到端口映射 ${pub}:${internal} —— 请人工确认 compose 里它的写法"
  fi
}

patch_port 12379 2379
patch_port 12380 2380
# 基建端口若有裸映射（各版本 openim-docker 不尽相同），一并钉回环：
patch_port 37017 27017 || true
patch_port 16379 6379  || true
patch_port 10005 9000  || true

# round 3 review（P1）：上游 compose 大量端口是「纯变量公开端口」形式
#（如 ${MINIO_PORT}:9000、${MINIO_CONSOLE_PORT}:9090、${ADMIN_API_PORT}:10009），
# 上面的字面量 patch 全都匹配不到 —— 操作员会以为只剩 10001/10002 对外，
# 而 MinIO/admin 其实还绑在 0.0.0.0。通杀：凡 ${VAR}:内部端口 的映射，
# 内部端口不在放行清单（10001/10002 = msggateway/api，测试期必须直连）
# 一律钉回环。
pin_variable_ports() {
  # 收口模式下放行清单只剩 metrics —— 10001/10002 也一起收进内网绑定。
  #
  # metrics 端口（OPENIM_METRICS_PORTS，默认 20112/20113 = msggateway / api）必须
  # 始终放行：Prometheus 跑在 circle_be 那套 compose 里，经 host.docker.internal
  # 抓宿主机；把它钉成回环，容器就抓不到了 —— 而聊天消息不过 circle_be，这是唯一
  # 能看见消息吞吐和连接数的地方，钉掉等于恶意刷屏重新变成不可见。
  # 它们本来也不该对公网开：收口时用 --collapse-public-ports 会把 HOST_BIND_IP
  # 整体切到 bridge，metrics 一并只对容器可见。
  local metrics_ports="${OPENIM_METRICS_PORTS:-20112 20113}"
  local allow_internal=" 10001 10002 ${metrics_ports} "
  [ "$COLLAPSE_PUBLIC_PORTS" = 1 ] && allow_internal=" ${metrics_ports} "
  local matches
  matches=$(grep -E '^[[:space:]]*-[[:space:]]*["'"'"']?\$\{[A-Z0-9_]+\}:[0-9]+["'"'"']?[[:space:]]*$' "$COMPOSE_FILE" | grep -v '127\.0\.0\.1' || true)
  [ -z "$matches" ] && return 0
  while IFS= read -r line; do
    local var internal
    var=$(printf '%s' "$line" | sed -E 's/.*\$\{([A-Z0-9_]+)\}:([0-9]+).*/\1/')
    internal=$(printf '%s' "$line" | sed -E 's/.*\$\{([A-Z0-9_]+)\}:([0-9]+).*/\2/')
    case "$allow_internal" in *" $internal "*) continue ;; esac
    sed -i.sedbak -E "s|^([[:space:]]*-[[:space:]]*)[\"']?\\\$\{${var}\}:${internal}[\"']?[[:space:]]*$|\1\"127.0.0.1:\${${var}}:${internal}\"|" "$COMPOSE_FILE" \
      && rm -f "$COMPOSE_FILE.sedbak"
    echo "已钉到回环（变量公开端口）: \${${var}}:${internal}"
  done <<< "$matches"
}
pin_variable_ports

# ── 2b. 收口：把网关/API 也关进回环 ─────────────────────────────────────────
# 只在显式传 --collapse-public-ports 时执行。两件事缺一不可：
#   - 字面量映射 10001/10002 由 patch_port 钉死（变量形式已由 pin_variable_ports 处理）
#   - HOST_BIND_IP 切回环 —— 上游大量映射写成 ${HOST_BIND_IP}:xxx，只钉字面量会漏
# 做完这一步，公网只剩 Caddy 的 80/443，Caddyfile 里的 rate_limit 才真正拦得住东西。
if [ "$COLLAPSE_PUBLIC_PORTS" = 1 ]; then
  echo
  echo "== 收口：msggateway/api 不再对公网直连 =="

  # ⚠️ 关键：**不能**钉到 127.0.0.1。Caddy 跑在容器里，经 host.docker.internal
  # （= docker bridge 网关）回连宿主机；绑到回环意味着只有宿主机自己连得上，
  # Caddy 会全部 502 —— 也就是刚被迁移到走域名的那批客户端 100% IM 中断，
  # 而 `ss -tlnp` 看上去一切正常。正确做法是绑到 bridge 网关 IP：对公网不可达
  # （它是私有地址），对容器可达。
  BRIDGE_IP="${OPENIM_GATEWAY_BIND_IP:-}"
  if [ -z "$BRIDGE_IP" ]; then
    BRIDGE_IP="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
  fi
  if [ -z "$BRIDGE_IP" ]; then
    echo "⚠ 无法探测 docker bridge 网关 IP —— 跳过端口收口。"
    echo "  手工指定后重跑：OPENIM_GATEWAY_BIND_IP=172.17.0.1 bash $0 $OPENIM_DIR --collapse-public-ports"
    echo "  （绝对不要用 127.0.0.1：Caddy 在容器里连不上，收口即全站 IM 中断）"
  else
    echo "网关端口将绑定到 docker bridge: ${BRIDGE_IP}（容器可达、公网不可达）"
    pin_port_to "$BRIDGE_IP" 10001 10001
    pin_port_to "$BRIDGE_IP" 10002 10002

    current_bind="$(grep -E '^HOST_BIND_IP=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)"
    if [ -z "$current_bind" ]; then
      echo "⚠ .env 里没有 HOST_BIND_IP —— 请人工确认上游 compose 的绑定写法"
    elif [ "$current_bind" = "$BRIDGE_IP" ]; then
      echo "已绑定 bridge: HOST_BIND_IP"
    else
      sed -i.sedbak "s|^HOST_BIND_IP=.*|HOST_BIND_IP=${BRIDGE_IP}|" "$ENV_FILE" && rm -f "$ENV_FILE.sedbak"
      echo "已切到 bridge: HOST_BIND_IP（原为 ${current_bind}）"
    fi

    echo "⚠ 收口后必须立刻冒烟验证，只看 ss 是不够的（它区分不了「公网关上了」和"
    echo "  「Caddy 也连不上了」）："
    echo "    curl -sS https://<API_DOMAIN>/openim-api/ -o /dev/null -w '%{http_code}\\n'"
    echo "    # 期望是 OpenIM 自己的应答（4xx/JSON 错误都算通），502 = 上游不可达，立即回滚"
    echo "⚠ 客户端必须已改走 wss://<域名>/openim-ws 与 https://<域名>/openim-api，"
    echo "  否则 force-recreate 之后所有直连客户端立刻断线。"
  fi
fi

# ── 2c. 内存上限固化成 compose override ────────────────────────────────────
# 原先只有 runbook 里的 `docker update --memory`，那是给**运行中容器**打的补丁：
# 下一次 `docker compose up -d --force-recreate`（升级上游、回滚、甚至重跑一次
# runbook）都会建出全新容器，上限一并消失，而且没有任何报错 —— 直到某次消息洪泛
# 把 mongo/kafka 的内存吃爆，拖垮的是整台机器（业务栈同机）。
#
# 写成 docker-compose.override.yml：compose 会自动加载这个文件名，操作员不用改
# 任何命令，之后每次 up 都带着上限。
#
# 服务名逐版本不同，所以从实际 compose 里读，而不是写死一份清单 —— override 里
# 出现基础文件没有的服务，compose 会直接报错。
OVERRIDE_FILE="$OPENIM_DIR/docker-compose.override.yml"
# 分两档，不能一刀切 1g：
# - 数据面（kafka/mongo/zookeeper/minio）是 JVM / 数据库，工作集本来就大。给 Kafka
#   1g 硬上限尤其危险 —— JVM 默认最大堆就是 1g 左右，洪泛时堆一涨就撞顶被 OOM kill，
#   重启、再灌、再挂，变成崩溃循环：机器是保住了，IM 消息投递却一直断。
# - 控制面（openim-* 的 Go 服务、etcd）常驻内存小，512m 足够，省下的额度留给数据面。
OPENIM_DATA_MEM_LIMIT="${OPENIM_DATA_MEM_LIMIT:-2g}"
OPENIM_SVC_MEM_LIMIT="${OPENIM_SVC_MEM_LIMIT:-512m}"
# Kafka 的堆必须显式压到低于容器上限，留出堆外（metaspace / direct buffer / 页缓存）
# 的余量；只设容器上限而不管堆，等于让 JVM 一路涨到被内核杀。
KAFKA_HEAP="${OPENIM_KAFKA_HEAP:--Xms256m -Xmx1g}"

write_resource_override() {
  local services
  # services: 之后、下一个顶格键之前，缩进两格的 `name:` 行即服务名。
  services=$(awk '
    /^services:/ { in_services=1; next }
    /^[a-zA-Z_-]+:/ { in_services=0 }
    in_services && /^  [a-zA-Z0-9._-]+:[[:space:]]*$/ {
      gsub(/[: ]/, "", $0); print
    }
  ' "$COMPOSE_FILE")

  if [ -z "$services" ]; then
    echo "⚠ 未能从 $COMPOSE_FILE 解析出服务名 —— 跳过内存上限 override，请人工处理"
    return 0
  fi

  if [ -f "$OVERRIDE_FILE" ] && ! grep -q 'circle_be:openim-harden' "$OVERRIDE_FILE"; then
    echo "⚠ $OVERRIDE_FILE 已存在且不是本脚本生成的 —— 不覆盖，请人工合并以下上限："
    echo "$services" | sed 's/^/    /'
    return 0
  fi

  {
    echo "# circle_be:openim-harden —— 由 deploy/openim-harden.sh 生成，可安全重跑覆盖。"
    echo "# 内存上限固化在这里而不是 \`docker update\`：后者在 force-recreate 后会静默消失。"
    echo "# 调整额度（注意本机总内存，上限是不预留的封顶值，不是预算）："
    echo "#   OPENIM_DATA_MEM_LIMIT=3g OPENIM_SVC_MEM_LIMIT=768m bash deploy/openim-harden.sh <dir>"
    echo "services:"
    echo "$services" | while IFS= read -r svc; do
      [ -z "$svc" ] && continue
      case "$svc" in
        *kafka* | *mongo* | *zookeeper* | *minio*)
          echo "  ${svc}:"
          echo "    mem_limit: ${OPENIM_DATA_MEM_LIMIT}"
          echo "    memswap_limit: ${OPENIM_DATA_MEM_LIMIT}"
          # 只有 Kafka 需要显式压堆：Mongo/MinIO 用的是可回收的页缓存，撞到上限
          # 内核会自己回收，不会像 JVM 那样一路涨到被杀。
          case "$svc" in
            *kafka*)
              echo "    environment:"
              echo "      KAFKA_HEAP_OPTS: \"${KAFKA_HEAP}\""
              ;;
          esac
          ;;
        *)
          echo "  ${svc}:"
          echo "    mem_limit: ${OPENIM_SVC_MEM_LIMIT}"
          echo "    memswap_limit: ${OPENIM_SVC_MEM_LIMIT}"
          ;;
      esac
    done
  } > "$OVERRIDE_FILE"

  echo "已写入内存上限 override: $OVERRIDE_FILE"
  echo "  数据面(kafka/mongo/zookeeper/minio) ${OPENIM_DATA_MEM_LIMIT}，其余 ${OPENIM_SVC_MEM_LIMIT}"
  echo "  Kafka 堆已压到 \"${KAFKA_HEAP}\"（必须低于容器上限，否则洪泛时 JVM 撑爆被 OOM kill 成崩溃循环）"
  echo "  覆盖服务: $(echo "$services" | tr '\n' ' ')"
  echo "  注：未设 CPU 上限 —— 拖垮整机的是内存耗尽，CPU 争抢只会降速且能自行恢复；"
  echo "      要限 CPU 需按本机核数决定，脚本不替你猜。"
}
write_resource_override

# ── 3. 汇总当前仍对 0.0.0.0 暴露的端口，供人工核对 ──────────────────────────
echo
if [ "$COLLAPSE_PUBLIC_PORTS" = 1 ]; then
  echo "== compose 中剩余的端口映射（收口后这里应该为空）=="
else
  echo "== compose 中剩余的端口映射（10001/10002 测试期保持对外是预期内）=="
fi
grep -nE '^[[:space:]]*-[[:space:]]*["'"'"']?(\$\{[A-Z0-9_]+\}:)?[0-9]+:[0-9]+|^[[:space:]]*-[[:space:]]*["'"'"']?\$\{[A-Z0-9_]+\}:[0-9]+' "$COMPOSE_FILE" | grep -v '127\.0\.0\.1' || true

echo
if echo "$ROTATED_KEYS" | grep -q OPENIM_SECRET; then
  NEW_SECRET="$(grep -E '^OPENIM_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  echo "== 必须同步到 circle_be/.env.production =="
  echo "OPENIM_ADMIN_SECRET=${NEW_SECRET}"
  echo "（circle_be 用它换取 OpenIM 管理员令牌，两边不一致 IM 全断）"
fi
echo
echo "改动已就绪但未生效 —— 按 deploy/openim-hardening-runbook.md 安排重启窗口。"
