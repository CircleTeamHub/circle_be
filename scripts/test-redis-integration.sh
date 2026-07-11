#!/usr/bin/env bash
set -euo pipefail

container="circle-be-redis-test-$$"
password="integration-$(openssl rand -hex 16)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "$container" \
  --publish 127.0.0.1::6379 \
  redis:7-alpine \
  redis-server --save '' --appendonly no --requirepass "$password" \
  >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e REDISCLI_AUTH="$password" "$container" redis-cli ping \
    2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 0.2
done

docker exec -e REDISCLI_AUTH="$password" "$container" redis-cli ping \
  | grep -q PONG
mapping="$(docker port "$container" 6379/tcp)"
port="${mapping##*:}"

REDIS_TEST_URL="redis://default:${password}@127.0.0.1:${port}" \
  npm test -- --runInBand redis/redis.integration.spec.ts
