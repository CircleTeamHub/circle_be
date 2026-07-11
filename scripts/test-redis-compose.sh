#!/usr/bin/env bash
set -euo pipefail

project="circle-redis-smoke-$$"
password="compose-$(openssl rand -hex 16)"
compose=(docker compose -p "$project" -f docker-compose.prod.yml --profile bundled-redis)

export DB_PASSWORD=test-only-db-password
export MINIO_ROOT_USER=test-only-minio
export MINIO_ROOT_PASSWORD=test-only-minio-password
export API_DOMAIN=api.example.test
export ADMIN_DOMAIN=admin.example.test
export ACME_EMAIL=ops@example.test

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if REDIS_PASSWORD= "${compose[@]}" run --rm --no-deps redis \
  >/dev/null 2>&1; then
  echo 'bundled Redis unexpectedly started without REDIS_PASSWORD' >&2
  exit 1
fi

export REDIS_PASSWORD="$password"
"${compose[@]}" up --detach redis >/dev/null

container="$("${compose[@]}" ps --quiet redis)"
for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  if [[ "$health" == healthy ]]; then
    break
  fi
  sleep 0.25
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]]

if docker exec "$container" redis-cli ping 2>&1 | grep -q PONG; then
  echo 'bundled Redis accepted an unauthenticated command' >&2
  exit 1
fi
docker exec -e REDISCLI_AUTH="$password" "$container" redis-cli ping \
  | grep -q PONG
[[ -z "$(docker port "$container" 6379/tcp)" ]]

config="$(docker exec -e REDISCLI_AUTH="$password" "$container" \
  redis-cli --raw CONFIG GET appendonly maxmemory maxmemory-policy)"
grep -qx 'yes' <<<"$config"
grep -qx '536870912' <<<"$config"
grep -qx 'noeviction' <<<"$config"
