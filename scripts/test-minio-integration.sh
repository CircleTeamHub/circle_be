#!/usr/bin/env bash
set -euo pipefail

container="circle-be-minio-test-$$"
access_key="circleintegration"
secret_key="$(openssl rand -hex 24)"
bucket="circle-integration-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "$container" \
  --publish 127.0.0.1::9000 \
  -e MINIO_ROOT_USER="$access_key" \
  -e MINIO_ROOT_PASSWORD="$secret_key" \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data >/dev/null

mapping="$(docker port "$container" 9000/tcp)"
port="${mapping##*:}"
url="http://127.0.0.1:${port}"
for _ in $(seq 1 60); do
  if curl --fail --silent "$url/minio/health/ready" >/dev/null; then
    break
  fi
  sleep 0.25
done
curl --fail --silent "$url/minio/health/ready" >/dev/null
docker exec "$container" mc alias set local http://127.0.0.1:9000 \
  "$access_key" "$secret_key" >/dev/null
docker exec "$container" mc mb "local/$bucket" >/dev/null

MINIO_TEST_URL="$url" \
MINIO_TEST_ACCESS_KEY="$access_key" \
MINIO_TEST_SECRET_KEY="$secret_key" \
MINIO_TEST_BUCKET="$bucket" \
  npm test -- --runInBand upload/upload.integration.spec.ts
