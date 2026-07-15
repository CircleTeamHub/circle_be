#!/usr/bin/env bash
# Deploys the admin static site from an immutable registry digest. This script is
# driven over SSH by circle_admin_web/.github/workflows/release.yml and can also
# be run manually:
#
#   RELEASE_TAG=v0.1.0 \
#   ADMIN_WEB_IMAGE=ghcr.io/circleteamhub/circle_admin_web@sha256:<64-hex-digest> \
#     bash deploy/admin-web-deploy.sh
#
# Required: RELEASE_TAG, ADMIN_WEB_IMAGE. Optional: GHCR_USER and GHCR_TOKEN for
# private images. Deployments share the backend release lock, update only the
# admin_web service, run public route checks, and automatically restore the
# exact previously running image if rollout or smoke verification fails.
set -euo pipefail

cd "$(dirname "$0")/.."

for name in RELEASE_TAG ADMIN_WEB_IMAGE; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
done

if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Refusing to deploy invalid version tag: $RELEASE_TAG" >&2
  exit 1
fi

if [[ ! "$ADMIN_WEB_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "ADMIN_WEB_IMAGE must be an immutable ghcr.io image digest" >&2
  exit 1
fi

# Serialize all changes to this Compose project with backend releases.
exec 200>/tmp/circle-be-release.lock
if ! flock -n 200; then
  echo "Another release is in progress (lock: /tmp/circle-be-release.lock)" >&2
  exit 1
fi

compose() {
  docker compose -f docker-compose.prod.yml -f docker-compose.admin-release.yml "$@"
}

previous_container_id="$(compose ps -q admin_web | head -n 1)"
previous_image=""
if [ -n "$previous_container_id" ]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$previous_container_id")"
fi
requested_image="$ADMIN_WEB_IMAGE"

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
  echo "warning: registry pull failed; checking the exact local digest" >&2
fi
if ! docker image inspect "$ADMIN_WEB_IMAGE" >/dev/null 2>&1; then
  echo "Image is unavailable from both the registry and local cache: $ADMIN_WEB_IMAGE" >&2
  exit 1
fi

wait_running() {
  local service="$1" container_id deadline state
  container_id="$(compose ps -q "$service" | head -n 1)"
  if [ -z "$container_id" ]; then
    echo "$service container not found after compose up" >&2
    return 1
  fi

  deadline=$(($(date +%s) + 60))
  while :; do
    state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || echo unknown)"
    if [ "$state" = "running" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$service did not reach running state within 60s (last: $state)" >&2
      compose logs --tail 100 "$service" >&2 || true
      return 1
    fi
    sleep 2
  done
}

rollback_admin() {
  echo "==> Rollout failed; restoring the previous admin_web image" >&2
  compose logs --tail 100 admin_web >&2 || true

  if [ -z "$previous_image" ]; then
    echo "No previous admin_web image exists; removing the failed service" >&2
    compose rm -sf admin_web >/dev/null 2>&1 || true
    return 0
  fi

  ADMIN_WEB_IMAGE="$previous_image"
  export ADMIN_WEB_IMAGE
  if ! compose up -d --no-build --no-deps admin_web; then
    echo "CRITICAL: automatic rollback could not recreate admin_web with $previous_image" >&2
    return 1
  fi
  if ! wait_running admin_web; then
    echo "CRITICAL: rollback container did not become ready; restore $previous_image manually" >&2
    return 1
  fi

  echo "Rollback complete: admin_web restored to $previous_image" >&2
  return 0
}

smoke_url() {
  local url="$1" label="$2" mode="$3" attempt code
  for attempt in $(seq 1 12); do
    code="$(curl -m 5 -s -o /dev/null -w '%{http_code}' "$url" || echo 000)"
    case "$mode:$code" in
      index:2*|index:3*|api:401)
        echo "smoke ok: $label (HTTP $code)"
        return 0
        ;;
    esac
    sleep 5
  done
  echo "smoke failed: $label after 12 attempts (last HTTP $code)" >&2
  return 1
}

echo "==> Rolling admin_web to $requested_image"
if ! compose up -d --no-build --no-deps admin_web; then
  rollback_admin || true
  exit 1
fi
if ! wait_running admin_web; then
  rollback_admin || true
  exit 1
fi

admin_domain="$(sed -n 's/^ADMIN_DOMAIN=//p' .env | tail -n 1)"
if [ -z "$admin_domain" ]; then
  echo "ADMIN_DOMAIN is unset; public smoke verification is mandatory" >&2
  rollback_admin || true
  exit 1
fi
if [ -z "$(compose ps -q --status running caddy 2>/dev/null || true)" ]; then
  echo "caddy is not running; public smoke verification cannot proceed" >&2
  rollback_admin || true
  exit 1
fi

if ! smoke_url "https://$admin_domain/" "admin index" index; then
  rollback_admin || true
  exit 1
fi
if ! smoke_url "https://$admin_domain/api/v1/auth/me" "admin API" api; then
  rollback_admin || true
  exit 1
fi

ADMIN_WEB_IMAGE="$requested_image"
export ADMIN_WEB_IMAGE
echo "==> Release $RELEASE_TAG deployed: admin_web is live on $requested_image"
