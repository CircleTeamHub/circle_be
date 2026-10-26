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

mkdir -p "$TARGET_ROOT/deploy" "$TARGET_ROOT/monitoring"
install -m 0755 "$SOURCE_ROOT/deploy/release-deploy.sh" "$TARGET_ROOT/deploy/release-deploy.sh"
install -m 0755 "$SOURCE_ROOT/deploy/gen-env.sh" "$TARGET_ROOT/deploy/gen-env.sh"
install -m 0755 "$SOURCE_ROOT/deploy/admin-web-deploy.sh" "$TARGET_ROOT/deploy/admin-web-deploy.sh"
install -m 0755 "$SOURCE_ROOT/deploy/caddy-entrypoint.sh" "$TARGET_ROOT/deploy/caddy-entrypoint.sh"
install -m 0755 "$SOURCE_ROOT/deploy/overlay-trusted-release-tooling.sh" "$TARGET_ROOT/deploy/overlay-trusted-release-tooling.sh"
install -m 0644 "$SOURCE_ROOT/deploy/app-env-preflight.sh" "$TARGET_ROOT/deploy/app-env-preflight.sh"
install -m 0644 "$SOURCE_ROOT/deploy/app-env-transaction.sh" "$TARGET_ROOT/deploy/app-env-transaction.sh"
install -m 0644 "$SOURCE_ROOT/deploy/offsite-backup.sh" "$TARGET_ROOT/deploy/offsite-backup.sh"
install -m 0755 "$SOURCE_ROOT/deploy/sync-ops-stacks.sh" "$TARGET_ROOT/deploy/sync-ops-stacks.sh"
install -m 0644 "$SOURCE_ROOT/deploy/Caddyfile.admin" "$TARGET_ROOT/deploy/Caddyfile.admin"
install -m 0755 "$SOURCE_ROOT/monitoring/sync-metrics-token.sh" "$TARGET_ROOT/monitoring/sync-metrics-token.sh"
for file in docker-compose.logs.yml alloy/config.alloy loki/config.yml \
  loki/rules/fake/circle.yml \
  grafana/provisioning/datasources/loki.yml \
  grafana/provisioning/datasources/loki.yml.example prometheus/logs-targets.yml \
  prometheus/prometheus.yml prometheus/prometheus.prod.yml \
  prometheus/alerts.yml; do
  target="$TARGET_ROOT/monitoring/$file"
  mkdir -p "$(dirname "$target")"
  install -m 0644 "$SOURCE_ROOT/monitoring/$file" "$target"
done
install -m 0644 "$SOURCE_ROOT/Dockerfile.caddy" "$TARGET_ROOT/Dockerfile.caddy"
install -m 0644 "$SOURCE_ROOT/docker-compose.prod.yml" "$TARGET_ROOT/docker-compose.prod.yml"
install -m 0644 "$SOURCE_ROOT/docker-compose.release.yml" "$TARGET_ROOT/docker-compose.release.yml"
install -m 0644 "$SOURCE_ROOT/docker-compose.admin-release.yml" "$TARGET_ROOT/docker-compose.admin-release.yml"

# Mark a tree whose tooling differs from its own source (a manual rollback or an
# offline overlay), so deploy/sync-ops-stacks.sh leaves the running ops stacks
# alone: their compose files here are historical while the rules are current,
# and syncing that mix would remove services added since. A dispatch of the
# very commit the tooling comes from is not mixed and stays unmarked. The next
# regular release replaces the tree and drops the marker with it.
source_sha="$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
target_sha="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$source_sha" ] || [ "$source_sha" != "$target_sha" ]; then
  printf 'tooling=%s\ntarget=%s\n' "${source_sha:-unknown}" "${target_sha:-unknown}" \
    > "$TARGET_ROOT/.release-tooling-overlay"
else
  rm -f -- "$TARGET_ROOT/.release-tooling-overlay"
fi
