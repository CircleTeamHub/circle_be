#!/usr/bin/env bash
# 服务器端 admin_web(管理端静态站)发版。由 circle_admin_web 仓库的
# .github/workflows/release.yml 通过 SSH 驱动;也可手动执行:
#
#   RELEASE_TAG=v0.1.0 ADMIN_WEB_IMAGE=ghcr.io/circleteamhub/circle_admin_web:v0.1.0 \
#     bash deploy/admin-web-deploy.sh
#
# 环境变量:RELEASE_TAG / ADMIN_WEB_IMAGE 必填;GHCR_USER / GHCR_TOKEN 可选
# (拉私有镜像用,CI 传 job 级临时 GITHUB_TOKEN)。
#
# 发版契约:
# - 只接受 v* 版本 tag;只动 admin_web 一个服务,其余服务不 pull 不重建;
# - 与 circle_be 发版共用同一把互斥锁(同一个 compose 栈,禁止并发变更);
# - 静态站容器重建是秒级的,不做蓝绿;发完走公网烟测,失败保留现场并让
#   CI 标红 —— 回滚 = 用旧 tag 重新触发(镜像还在本地缓存,秒回)。
set -euo pipefail

cd "$(dirname "$0")/.."

for name in RELEASE_TAG ADMIN_WEB_IMAGE; do
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

# 与 release-deploy.sh 同一把锁:序列化对这个 compose 栈的所有发版操作。
exec 200>/tmp/circle-be-release.lock
if ! flock -n 200; then
  echo "Another release is in progress (lock: /tmp/circle-be-release.lock)" >&2
  exit 1
fi

compose() {
  docker compose -f docker-compose.prod.yml -f docker-compose.admin-release.yml "$@"
}

if [ -n "${GHCR_TOKEN:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  printf '%s' "$GHCR_TOKEN" |
    docker login ghcr.io -u "${GHCR_USER:?GHCR_USER is required when GHCR_TOKEN is set}" --password-stdin
fi

export ADMIN_WEB_IMAGE

echo "==> Pulling admin_web image: $ADMIN_WEB_IMAGE"
if ! compose pull --quiet admin_web; then
  echo "warning: pull failed; falling back to local image cache"
fi
if ! docker image inspect "$ADMIN_WEB_IMAGE" >/dev/null 2>&1; then
  echo "Image not available locally and pull failed: $ADMIN_WEB_IMAGE" >&2
  exit 1
fi

echo "==> Rolling admin_web to $ADMIN_WEB_IMAGE"
compose up -d --no-build --no-deps admin_web

# nginx 静态站没有 healthcheck:等容器进入 running,再走公网烟测验证整条链路
# (caddy → admin_web nginx;/api/ 反代到 circle_be 的路径也一并验证)。
container_id="$(compose ps -q admin_web | head -n 1)"
if [ -z "$container_id" ]; then
  echo "admin_web container not found after compose up" >&2
  exit 1
fi
deadline=$(($(date +%s) + 60))
while :; do
  state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || echo unknown)"
  if [ "$state" = "running" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "admin_web did not reach running state within 60s (last: $state)" >&2
    compose logs --tail 100 admin_web >&2 || true
    exit 1
  fi
  sleep 2
done

smoke_url() {
  local url="$1" label="$2" attempt code
  for attempt in $(seq 1 12); do
    code="$(curl -m 5 -s -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    case "$code" in
      2*|3*|401|403|404)
        echo "smoke ok: $label (HTTP $code)"
        return 0
        ;;
    esac
    sleep 5
  done
  echo "smoke failed: $label after 12 attempts (last HTTP $code)" >&2
  return 1
}

admin_domain="$(sed -n 's/^ADMIN_DOMAIN=//p' .env | tail -n 1)"
if [ -n "$admin_domain" ] && [ -n "$(compose ps -q --status running caddy 2>/dev/null || true)" ]; then
  # 首页验证静态资源;/api/ 验证 nginx → circle-be-app 的反代链路(预期 401/404)。
  smoke_ok=1
  smoke_url "https://$admin_domain/" "admin index" || smoke_ok=0
  smoke_url "https://$admin_domain/api/v1/auth/me" "admin /api proxy" || smoke_ok=0
  if [ "$smoke_ok" != "1" ]; then
    compose logs --tail 100 admin_web >&2 || true
    echo "Rollback: re-run the release with the previous tag" >&2
    echo "(RELEASE_TAG=vOLD ADMIN_WEB_IMAGE=ghcr.io/...:vOLD bash deploy/admin-web-deploy.sh)" >&2
    exit 1
  fi
else
  echo "caddy not running or ADMIN_DOMAIN unset; skipping public smoke test"
fi

echo "==> Release $RELEASE_TAG deployed: admin_web is live on $ADMIN_WEB_IMAGE"
