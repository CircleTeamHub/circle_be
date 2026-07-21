#!/usr/bin/env bash
# OpenIM 栈加固（#106/#107）。在服务器上、openim-docker 目录旁执行：
#
#   bash deploy/openim-harden.sh [openim-docker 路径，默认 ~/openim-docker]
#
# 做什么（幂等，全部只改文件、绝不重启容器）：
#   1. .env 里仍是上游公开默认值的密钥 → 换成强随机（OPENIM_SECRET / Mongo / Redis / MinIO）
#   2. etcd 的裸端口映射（12379/12380，不吃 HOST_BIND_IP 前缀）→ 钉到 127.0.0.1
#   3. Mongo/Redis/MinIO/Kafka 等基建端口映射 → 钉到 127.0.0.1
#      （msggateway 10001 / api 10002 保持对外 —— 测试期客户端直连，
#       等域名 + Caddy 就绪后再把 HOST_BIND_IP 整体切 127.0.0.1）
#   4. 打印需要同步到 circle_be .env.production 的 OPENIM_ADMIN_SECRET 新值
#
# 改完后需要的重启（见 runbook，自行安排窗口）：
#   cd <openim-docker> && docker compose up -d --force-recreate
#   cd <circle_be>    && 更新 .env.production 后重启 app 容器
#
# 每个被改的文件都会留下 .bak.<时间戳> 备份；回滚 = 恢复备份 + 同样的重启。
set -euo pipefail
umask 077

OPENIM_DIR="${1:-$HOME/openim-docker}"
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
rotate_if_default "MONGO_PASSWORD"     "openIM123"
rotate_if_default "MONGO_OPENIM_PASSWORD" "openIM123"
rotate_if_default "REDIS_PASSWORD"     "openIM123"
rotate_if_default "MINIO_SECRET_ACCESS_KEY" "openIM123"

# ── 2. etcd 裸映射钉回环（#106 第三条：它不吃 HOST_BIND_IP 前缀）──────────────
# 匹配 "12379:2379" / '12380:2380' 两种引号与缩进变体，未命中则提示人工检查。
patch_port() {
  local pub="$1" internal="$2"
  if grep -qE "^\s*-\s*[\"']?${pub}:${internal}[\"']?\s*$" "$COMPOSE_FILE"; then
    sed -i.sedbak -E "s|^(\s*-\s*)[\"']?${pub}:${internal}[\"']?\s*$|\1\"127.0.0.1:${pub}:${internal}\"|" "$COMPOSE_FILE" \
      && rm -f "$COMPOSE_FILE.sedbak"
    echo "已钉到回环: ${pub}:${internal}"
  elif grep -qE "127\.0\.0\.1:${pub}:${internal}" "$COMPOSE_FILE"; then
    echo "已是回环: ${pub}:${internal}"
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

# ── 3. 汇总当前仍对 0.0.0.0 暴露的端口，供人工核对 ──────────────────────────
echo
echo "== compose 中剩余的端口映射（10001/10002 测试期保持对外是预期内）=="
grep -nE "^\s*-\s*[\"']?(\\\$\{HOST_BIND_IP\}:)?[0-9]+:[0-9]+" "$COMPOSE_FILE" || true

echo
if echo "$ROTATED_KEYS" | grep -q OPENIM_SECRET; then
  NEW_SECRET="$(grep -E '^OPENIM_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  echo "== 必须同步到 circle_be/.env.production =="
  echo "OPENIM_ADMIN_SECRET=${NEW_SECRET}"
  echo "（circle_be 用它换取 OpenIM 管理员令牌，两边不一致 IM 全断）"
fi
echo
echo "改动已就绪但未生效 —— 按 deploy/openim-hardening-runbook.md 安排重启窗口。"
