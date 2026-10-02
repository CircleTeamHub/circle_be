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

# The upstream community images and legacy binaries are no longer available.
# Build the same release from its immutable source revision for this fixture.
docker build --tag circle-be-minio-test:local docker/minio-test
docker run --detach --rm \
  --name "$container" \
  --publish 127.0.0.1::9000 \
  -e MINIO_ROOT_USER="$access_key" \
  -e MINIO_ROOT_PASSWORD="$secret_key" \
  circle-be-minio-test:local server /data >/dev/null

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
MINIO_TEST_URL="$url" \
MINIO_TEST_ACCESS_KEY="$access_key" \
MINIO_TEST_SECRET_KEY="$secret_key" \
MINIO_TEST_BUCKET="$bucket" \
  npm test -- --runInBand upload/upload.integration.spec.ts
