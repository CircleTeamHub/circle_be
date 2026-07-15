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
#   停旧色 → 公网烟测 → 删旧色;任何一步失败都让 CI 变红,
#   烟测失败会自动把旧版本拉回来。
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

service_upstream() {
  case "$1" in
    circle_be) echo "circle-be-blue:3000" ;;
    circle_be_green) echo "circle-be-green:3000" ;;
    *) echo "unknown backend service: $1" >&2; return 1 ;;
  esac
}

container_upstream() {
  local cid name
  cid="$(running "$1")"
  if [ -z "$cid" ]; then
    echo "$1 has no running container" >&2
    return 1
  fi
  name="$(docker inspect --format '{{.Name}}' "$cid")"
  printf '%s:3000\n' "${name#/}"
}

reload_caddy_config() {
  local upstreams="$1"
  if [ -z "$(running caddy)" ]; then
    echo "caddy is not running; refusing to change backend routing" >&2
    return 1
  fi
  if [ -z "$upstreams" ]; then
    echo "backend upstream list is empty" >&2
    return 1
  fi

  compose cp deploy/Caddyfile.admin caddy:/tmp/Caddyfile.release
  compose exec -T -e BACKEND_UPSTREAMS="$upstreams" caddy \
    caddy validate --config /tmp/Caddyfile.release --adapter caddyfile
  compose exec -T -e BACKEND_UPSTREAMS="$upstreams" caddy \
    caddy reload --config /tmp/Caddyfile.release --adapter caddyfile
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
if [ -n "$blue" ] && [ -n "$green" ]; then
  echo "Both backend colors are running after an interrupted release; refusing to guess which one is live." >&2
  echo "Inspect Caddy routing and container health, then stop the confirmed standby before retrying." >&2
  exit 1
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
echo "==> Live color: ${live:-none}; deploying $RELEASE_TAG to: $standby"

# Route only to the exact live container before changing colors. This also
# migrates safely from the legacy green service, which may still own the old
# `circle_be` alias. Copy through /tmp because an already-running Caddy may
# still use the legacy single-file bind mount from a previous release.
if [ -n "$live" ]; then
  initial_upstream="$(container_upstream "$live")"
else
  initial_upstream="$(service_upstream "$standby")"
fi
if ! reload_caddy_config "$initial_upstream"; then
  echo "Failed to validate and reload the blue-green Caddy routing" >&2
  exit 1
fi

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

# Before the new color is healthy, only downtime mode has stopped the live app.
# Restore it on any migration/startup failure so an operational error does not
# extend the maintenance window indefinitely.
restore_live() {
  if [ "${RELEASE_DOWNTIME:-0}" != "1" ] || [ -z "$live" ]; then
    return 0
  fi

  echo "==> Restarting previous version $live (the schema may already be migrated)" >&2
  if ! compose start "$live"; then
    echo "CRITICAL: previous version $live could not be restarted" >&2
    return 1
  fi
  if ! wait_healthy "$live" 120; then
    echo "CRITICAL: previous version $live did not return healthy" >&2
    return 1
  fi
  echo "==> Previous version $live restored" >&2
}

# 走 Caddy 的公网烟测:外部视角验证 TLS/反代/应用整条链路。auth/me 是
# 已知存在且受 JWT 保护的路由;未带鉴权必须返回 401,其他状态均视为故障。
smoke() {
  local api_domain attempt code
  api_domain="$(sed -n 's/^API_DOMAIN=//p' .env | tail -n 1)"
  if [ -z "$api_domain" ]; then
    echo "API_DOMAIN is unset; public smoke verification is mandatory" >&2
    return 1
  fi
  if [ -z "$(running caddy)" ]; then
    echo "caddy is not running; public smoke verification cannot proceed" >&2
    return 1
  fi
  for attempt in $(seq 1 12); do
    code="$(curl -m 5 -s -o /dev/null -w '%{http_code}' "https://$api_domain/api/v1/auth/me" || echo 000)"
    if [ "$code" = "401" ]; then
      echo "public smoke ok (HTTP $code via https://$api_domain)"
      return 0
    fi
    sleep 5
  done
  echo "public smoke failed after 12 attempts (last HTTP $code)" >&2
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

# The new color has a permanent, unambiguous container name. Put it first only
# after its health gate; retain the exact old container as rollback fallback.
standby_upstream="$(service_upstream "$standby")"
cutover_upstreams="$standby_upstream"
if [ -n "$live" ] && [ -n "$(running "$live")" ]; then
  cutover_upstreams="$standby_upstream $(container_upstream "$live")"
fi
if ! reload_caddy_config "$cutover_upstreams"; then
  echo "Failed to switch Caddy to the healthy standby" >&2
  compose rm -sf "$standby" || true
  restore_live || true
  exit 1
fi

# ── 切换:停旧色(保留容器以便秒级回滚)→ 烟测 → 通过才删旧色 ────
if [ -n "$live" ] && [ -n "$(running "$live")" ]; then
  echo "==> $standby healthy; stopping $live"
  compose stop "$live"
fi

if smoke; then
  if [ -n "$live" ]; then
    compose rm -f "$live"
  fi
  reload_caddy_config "$standby_upstream" ||
    echo "warning: Caddy still has the removed color as an inactive fallback" >&2
  echo "==> Release $RELEASE_TAG deployed: $standby is live on $CIRCLE_BE_IMAGE"
else
  echo "==> Smoke test failed; rolling back to previous version" >&2
  compose logs --tail 100 "$standby" >&2 || true
  compose rm -sf "$standby" || true
  if [ -n "$live" ]; then
    compose start "$live"
    if wait_healthy "$live" 120; then
      reload_caddy_config "$(container_upstream "$live")" ||
        echo "warning: Caddy rollback cleanup failed; the restored color remains a configured fallback" >&2
    else
      echo "warning: previous version failed to come back healthy; manual intervention required" >&2
    fi
    echo "==> Rolled back: $live restored" >&2
  fi
  exit 1
fi
