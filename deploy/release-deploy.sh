#!/usr/bin/env bash
# 服务器端蓝绿发版。由 .github/workflows/release.yml 通过 SSH 驱动;
# 也可以手动执行(回滚/重放,见 DEPLOY.md §6):
#
#   RELEASE_TAG=v0.1.0 CIRCLE_BE_IMAGE=ghcr.io/circleteamhub/circle_be:v0.1.0 \
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

case "$RELEASE_TAG" in
  v[0-9]*) ;;
  *)
    echo "Refusing to deploy non-version tag: $RELEASE_TAG" >&2
    exit 1
    ;;
esac

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
  echo "warning: both colors running (interrupted release?); keeping circle_be, removing circle_be_green"
  compose rm -sf circle_be_green
  green=""
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

# 走 Caddy 的公网烟测:外部视角验证 TLS/反代/应用整条链路;
# 未带鉴权,2xx/3xx/401/403/404 都算活,5xx/超时判死。
smoke() {
  local api_domain attempt code
  api_domain="$(sed -n 's/^API_DOMAIN=//p' .env | tail -n 1)"
  if [ -z "$api_domain" ] || [ -z "$(running caddy)" ]; then
    echo "caddy not running or API_DOMAIN unset; skipping public smoke test"
    return 0
  fi
  for attempt in $(seq 1 12); do
    code="$(curl -m 5 -s -o /dev/null -w '%{http_code}' "https://$api_domain/api/v1/auth/me" || echo 000)"
    case "$code" in
      2*|3*|401|403|404)
        echo "public smoke ok (HTTP $code via https://$api_domain)"
        return 0
        ;;
    esac
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
compose run --rm migrate

# ── 起新色并等健康 ──────────────────────────────────────────────
echo "==> Starting $standby"
compose up -d --no-build --no-deps "$standby"
if ! wait_healthy "$standby" 300; then
  compose logs --tail 200 "$standby" >&2 || true
  compose rm -sf "$standby" || true
  if [ "${RELEASE_DOWNTIME:-0}" = "1" ] && [ -n "$live" ]; then
    echo "==> Restarting previous version $live (note: schema already migrated," >&2
    echo "    a breaking migration may require restoring the backup above)" >&2
    compose start "$live" || true
  fi
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
  echo "==> Release $RELEASE_TAG deployed: $standby is live on $CIRCLE_BE_IMAGE"
else
  echo "==> Smoke test failed; rolling back to previous version" >&2
  compose logs --tail 100 "$standby" >&2 || true
  compose rm -sf "$standby" || true
  if [ -n "$live" ]; then
    compose start "$live"
    wait_healthy "$live" 120 ||
      echo "warning: previous version failed to come back healthy; manual intervention required" >&2
    echo "==> Rolled back: $live restored" >&2
  fi
  exit 1
fi
