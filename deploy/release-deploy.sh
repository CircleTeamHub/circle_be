#!/usr/bin/env bash
# 服务器端蓝绿发版。由 .github/workflows/release.yml 通过 SSH 驱动;
# 也可以手动执行(回滚/重放,见 DEPLOY.md §6):
#
#   RELEASE_TAG=v0.1.0 \
#   CIRCLE_BE_IMAGE=ghcr.io/circleteamhub/circle_be@sha256:<64-hex-digest> \
#     bash deploy/release-deploy.sh
#
# 环境变量:
#   RELEASE_TAG        必填,v 开头的版本 tag
#   CIRCLE_BE_IMAGE    必填,要部署的不可变镜像引用
#   GHCR_USER/TOKEN    可选,拉私有镜像用(CI 传 job 级临时 GITHUB_TOKEN;
#                      手动回滚时镜像通常还在本地缓存,可不传)
#   RELEASE_DOWNTIME=1 可选,停机模式:先停旧版本再跑迁移。仅用于
#                      不向后兼容的迁移;默认蓝绿模式要求迁移向后兼容
#                      (旧代码 + 新 schema 需共存到切换完成)。
#
# 发版契约:
# - 只接受 v* 版本 tag;
# - 只动应用面(circle_be 蓝/绿 + 一次性 migrate);postgres/redis/minio/
#   caddy/admin_web 属开通期资产(DEPLOY.md §4),发版不 pull 不重建;
# - 本机永不构建镜像(--no-build);
# - 顺序:锁 → 拉镜像 → 备份数据库 → 迁移 → 起新色 → 容器健康门禁 →
#   校验/切换代理 → 公网烟测 → 停删旧色;任何一步失败都让 CI 变红,
#   烟测失败会自动把代理切回旧版本并清理新色。
set -euo pipefail

cd "$(dirname "$0")/.."

for name in RELEASE_TAG CIRCLE_BE_IMAGE; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
done

if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Refusing to deploy invalid version tag: $RELEASE_TAG" >&2
  exit 1
fi

if [[ ! "$CIRCLE_BE_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "CIRCLE_BE_IMAGE must be an immutable ghcr.io image digest" >&2
  exit 1
fi

# 单飞锁:同一时刻只允许一个发版(CI 队列 + 手动操作重叠时的兜底)。
exec 200>/tmp/circle-be-release.lock
if ! flock -n 200; then
  echo "Another release is in progress (lock: /tmp/circle-be-release.lock)" >&2
  exit 1
fi

compose() {
  docker compose -f docker-compose.prod.yml -f docker-compose.release.yml "$@"
}

running() {
  compose ps -q --status running "$1" 2>/dev/null || true
}

container_upstream() {
  local cid name
  cid="$(running "$1")"
  if [ -z "$cid" ]; then
    echo "$1 has no running container" >&2
    return 1
  fi
  if ! name="$(docker inspect --format '{{.Name}}' "$cid")" || [ -z "$name" ]; then
    echo "Could not resolve the container endpoint for $1" >&2
    return 1
  fi
  printf '%s:3000\n' "${name#/}"
}

RELEASE_STATE_DIR="${RELEASE_STATE_DIR:-.release}"

recorded_live_color() {
  cat "$RELEASE_STATE_DIR/active-color" 2>/dev/null || true
}

persist_active_color() {
  local color="$1" temp
  mkdir -p "$RELEASE_STATE_DIR"
  temp="$RELEASE_STATE_DIR/active-color.tmp.$$"
  printf '%s\n' "$color" > "$temp"
  mv -f "$temp" "$RELEASE_STATE_DIR/active-color"
}

switch_proxy() {
  local target
  target="$(container_upstream "$1")" || return 1
  if [ -z "$(running caddy)" ]; then
    echo "Caddy is not running; refusing to change the active app color." >&2
    return 1
  fi
  if ! compose exec -T -e "CIRCLE_BE_UPSTREAM=$target" caddy \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "Caddy validation failed for upstream $target." >&2
    return 1
  fi
  compose exec -T -e "CIRCLE_BE_UPSTREAM=$target" caddy \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

# 登录凭证放进一次性的隔离 DOCKER_CONFIG,不污染主机默认凭证存储。
if [ -n "${GHCR_TOKEN:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  printf '%s' "$GHCR_TOKEN" |
    docker login ghcr.io -u "${GHCR_USER:?GHCR_USER is required when GHCR_TOKEN is set}" --password-stdin
fi

export CIRCLE_BE_IMAGE

echo "==> Pulling release image: $CIRCLE_BE_IMAGE"
if ! compose pull --quiet circle_be migrate; then
  echo "warning: pull failed; falling back to local image cache"
fi
if ! docker image inspect "$CIRCLE_BE_IMAGE" >/dev/null 2>&1; then
  echo "Image not available locally and pull failed: $CIRCLE_BE_IMAGE" >&2
  exit 1
fi

# ── 识别在役颜色 ────────────────────────────────────────────────
blue="$(running circle_be)"
green="$(running circle_be_green)"
proxy_aligned=0
if [ -n "$blue" ] && [ -n "$green" ]; then
  recorded_live="$(recorded_live_color)"
  case "$recorded_live" in
    circle_be)
      live=circle_be standby=circle_be_green
      ;;
    circle_be_green)
      live=circle_be_green standby=circle_be
      ;;
    *)
      echo "Both app colors are running, but active-color state is missing or invalid." >&2
      echo "Refusing to guess which container is live; repair $RELEASE_STATE_DIR/active-color." >&2
      exit 1
      ;;
  esac
  echo "warning: both colors running; preserving recorded live color $live"
  if ! switch_proxy "$live"; then
    echo "Failed to restore Caddy to $live; leaving both colors running." >&2
    exit 1
  fi
  proxy_aligned=1
  persist_active_color "$live"
  compose rm -sf "$standby"
  if [ "$standby" = "circle_be" ]; then
    blue=""
  else
    green=""
  fi
fi
if [ -n "$blue" ]; then
  live=circle_be standby=circle_be_green
elif [ -n "$green" ]; then
  live=circle_be_green standby=circle_be
else
  live="" standby=circle_be
fi

if [ -z "$live" ] && [ -z "$(running postgres)" ]; then
  echo "Stack not initialized (no app color and postgres is down)." >&2
  echo "Run the DEPLOY.md §4 bootstrap first; releases only update a live stack." >&2
  exit 1
fi
if [ -n "$live" ]; then
  if [ "$proxy_aligned" != "1" ] && ! switch_proxy "$live"; then
    echo "Failed to align Caddy with live color $live; refusing to deploy." >&2
    exit 1
  fi
  persist_active_color "$live"
fi
echo "==> Live color: ${live:-none}; deploying $RELEASE_TAG to: $standby"

wait_healthy() {
  local svc="$1" timeout="$2" cid status deadline
  cid="$(compose ps -q "$svc" 2>/dev/null | head -n 1)"
  if [ -z "$cid" ]; then
    echo "$svc has no container to wait for" >&2
    return 1
  fi
  deadline=$(($(date +%s) + timeout))
  while :; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$svc did not become healthy within ${timeout}s (last status: $status)" >&2
      return 1
    fi
    sleep 5
  done
}

ensure_live() {
  if [ -z "$live" ]; then
    return 1
  fi
  if [ -z "$(running "$live")" ] && ! compose start "$live"; then
    echo "CRITICAL: previous version $live could not be restarted" >&2
    return 1
  fi
  if ! wait_healthy "$live" 120; then
    echo "CRITICAL: previous version $live did not return healthy" >&2
    return 1
  fi
}

# Before the new color is healthy, only downtime mode has stopped the live app.
# Restore it on any migration/startup failure so an operational error does not
# extend the maintenance window indefinitely.
restore_live() {
  if [ "${RELEASE_DOWNTIME:-0}" != "1" ] || [ -z "$live" ]; then
    return 0
  fi

  echo "==> Restarting previous version $live (the schema may already be migrated)" >&2
  ensure_live || return 1
  echo "==> Previous version $live restored" >&2
}

# 走 Caddy 的公网烟测:外部视角验证 TLS/反代/应用整条链路。auth/me 是
# 已知存在的路由;未带鉴权时 401/403 是健康响应,404 必须视为路由故障。
smoke() {
  local api_domain attempt code headers body
  api_domain="$(sed -n 's/^API_DOMAIN=//p' .env | tail -n 1)"
  if [ -z "$api_domain" ]; then
    echo "API_DOMAIN is unset; public smoke verification is mandatory" >&2
    return 1
  fi
  if [ -z "$(running caddy)" ]; then
    echo "caddy is not running; public smoke verification cannot proceed" >&2
    return 1
  fi

  headers="$(mktemp)"
  body="$(mktemp)"
  for attempt in $(seq 1 12); do
    : >"$headers"
    : >"$body"
    if ! code="$(curl -m 5 -sS -H 'Accept: application/json' -D "$headers" -o "$body" \
      -w '%{http_code}' "https://$api_domain/api/v1/auth/me")"; then
      code=000
    fi
    case "$code" in
      401|403)
        if grep -Eqi '^content-type:[[:space:]]*application/(problem\+)?json([;[:space:]]|$)' "$headers"; then
          echo "public smoke ok (HTTP $code JSON via https://$api_domain)"
          rm -f "$headers" "$body"
          return 0
        fi
        ;;
    esac
    sleep 5
  done
  echo "public smoke failed after 12 attempts (last HTTP $code; expected 401/403 JSON)" >&2
  head -c 500 "$body" >&2 || true
  rm -f "$headers" "$body"
  return 1
}

# ── 迁移前先做数据库备份(pg_dump,保留最近 7 份)────────────────
if [ -n "$(running postgres)" ]; then
  backup_dir="$HOME/circle_be_backups"
  mkdir -p "$backup_dir"
  backup_file="$backup_dir/circle-$(date +%Y%m%d-%H%M%S)-pre-$RELEASE_TAG.sql.gz"
  echo "==> Backing up database to $backup_file"
  compose exec -T postgres pg_dump -U circle -d circle | gzip > "$backup_file"
  ls -1t "$backup_dir"/circle-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
fi

# ── 停机模式:先停旧色再迁移(仅不向后兼容迁移使用)──────────────
if [ "${RELEASE_DOWNTIME:-0}" = "1" ] && [ -n "$live" ]; then
  echo "==> Downtime mode: stopping $live before migration"
  compose stop "$live"
fi

# ── 用发布镜像跑迁移 ────────────────────────────────────────────
# 默认(蓝绿)模式下旧版本仍在服务:迁移必须向后兼容(expand/contract)。
echo "==> Running prisma migrate deploy from $CIRCLE_BE_IMAGE"
if ! compose run --rm migrate; then
  echo "Migration failed; the database may require manual inspection" >&2
  restore_live || true
  exit 1
fi

# ── 起新色并等健康 ──────────────────────────────────────────────
echo "==> Starting $standby"
if ! compose up -d --no-build --no-deps "$standby"; then
  echo "Failed to create $standby" >&2
  compose logs --tail 200 "$standby" >&2 || true
  compose rm -sf "$standby" || true
  restore_live || true
  exit 1
fi
if ! wait_healthy "$standby" 300; then
  compose logs --tail 200 "$standby" >&2 || true
  compose rm -sf "$standby" || true
  restore_live || true
  exit 1
fi

# ── 切换代理 → 烟测 → 通过后才停/删旧色 ──────────────────────
echo "==> $standby healthy; switching Caddy upstream"
if ! switch_proxy "$standby"; then
  echo "==> Caddy switch failed; leaving previous version $live live" >&2
  if [ -n "$live" ]; then
    if ! ensure_live; then
      echo "warning: leaving both colors running for manual recovery" >&2
      exit 1
    fi
    compose rm -sf "$standby" || true
  else
    echo "warning: no previous version exists; leaving standby running" >&2
  fi
  exit 1
fi
if ! persist_active_color "$standby"; then
  echo "==> Could not persist active color; rolling Caddy back" >&2
  if [ -n "$live" ]; then
    if ! ensure_live || ! switch_proxy "$live"; then
      echo "warning: Caddy rollback failed; leaving both colors running" >&2
      exit 1
    fi
    compose rm -sf "$standby" || true
  else
    echo "warning: no previous version exists; leaving standby running" >&2
  fi
  exit 1
fi

if smoke; then
  if [ -n "$live" ]; then
    if [ -n "$(running "$live")" ]; then
      echo "==> Public smoke passed; stopping $live"
      compose stop "$live"
    fi
    compose rm -f "$live"
  fi
  echo "==> Release $RELEASE_TAG deployed: $standby is live on $CIRCLE_BE_IMAGE"
else
  echo "==> Smoke test failed; rolling back to previous version" >&2
  compose logs --tail 100 "$standby" >&2 || true
  if [ -n "$live" ]; then
    if ! ensure_live; then
      echo "warning: previous version is unavailable; leaving standby in service" >&2
      exit 1
    fi
    if ! switch_proxy "$live"; then
      echo "warning: Caddy rollback failed; leaving both colors running for manual recovery" >&2
      exit 1
    fi
    persist_active_color "$live"
    compose rm -sf "$standby" || true
    echo "==> Rolled back: $live restored" >&2
  else
    echo "warning: no previous version exists; leaving the healthy standby running" >&2
  fi
  exit 1
fi
