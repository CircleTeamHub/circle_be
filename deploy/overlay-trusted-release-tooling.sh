#!/usr/bin/env bash
# Overlay the current, CI-verified deployment contract onto a historical
# application tree. The target keeps its own schema compatibility metadata.
set -euo pipefail

SOURCE_ROOT="${1:-}"
TARGET_ROOT="${2:-}"

if [ ! -d "$SOURCE_ROOT" ] || [ ! -d "$TARGET_ROOT" ]; then
  echo "usage: $0 <trusted-source-root> <historical-target-root>" >&2
  exit 1
fi

mkdir -p "$TARGET_ROOT/deploy"
install -m 0755 "$SOURCE_ROOT/deploy/release-deploy.sh" "$TARGET_ROOT/deploy/release-deploy.sh"
install -m 0755 "$SOURCE_ROOT/deploy/admin-web-deploy.sh" "$TARGET_ROOT/deploy/admin-web-deploy.sh"
install -m 0755 "$SOURCE_ROOT/deploy/caddy-entrypoint.sh" "$TARGET_ROOT/deploy/caddy-entrypoint.sh"
install -m 0755 "$SOURCE_ROOT/deploy/overlay-trusted-release-tooling.sh" "$TARGET_ROOT/deploy/overlay-trusted-release-tooling.sh"
install -m 0644 "$SOURCE_ROOT/deploy/app-env-preflight.sh" "$TARGET_ROOT/deploy/app-env-preflight.sh"
install -m 0644 "$SOURCE_ROOT/deploy/app-env-transaction.sh" "$TARGET_ROOT/deploy/app-env-transaction.sh"
install -m 0644 "$SOURCE_ROOT/deploy/offsite-backup.sh" "$TARGET_ROOT/deploy/offsite-backup.sh"
install -m 0644 "$SOURCE_ROOT/deploy/Caddyfile.admin" "$TARGET_ROOT/deploy/Caddyfile.admin"
install -m 0644 "$SOURCE_ROOT/Dockerfile.caddy" "$TARGET_ROOT/Dockerfile.caddy"
install -m 0644 "$SOURCE_ROOT/docker-compose.prod.yml" "$TARGET_ROOT/docker-compose.prod.yml"
install -m 0644 "$SOURCE_ROOT/docker-compose.release.yml" "$TARGET_ROOT/docker-compose.release.yml"
install -m 0644 "$SOURCE_ROOT/docker-compose.admin-release.yml" "$TARGET_ROOT/docker-compose.admin-release.yml"
