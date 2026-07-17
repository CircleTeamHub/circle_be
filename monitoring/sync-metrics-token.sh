#!/usr/bin/env bash
# Copies METRICS_AUTH_TOKEN out of .env.production into the credentials file
# Prometheus reads (monitoring/prometheus/metrics_token), with the ownership and
# mode the Prometheus container needs.
#
#   bash monitoring/sync-metrics-token.sh
#
# Run it once during setup, and again after rotating METRICS_AUTH_TOKEN —
# otherwise every scrape 401s and the circle-be target goes DOWN.
#
# Why a script rather than "copy the token":
#   - deploy/gen-env.sh generates the token, so the operator never sees or types
#     it; hand-copying invites truncation and trailing-whitespace bugs.
#   - Prometheus runs as uid 65534 (nobody). A 0600 file owned by the deploying
#     user is unreadable inside the container, which surfaces as a 401 — the
#     same symptom as a wrong token, and a genuinely confusing one to debug.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
TOKEN_FILE="monitoring/prometheus/metrics_token"
PROM_UID=65534

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found. Run deploy/gen-env.sh first (see DEPLOY.md §4)." >&2
  exit 1
fi

# Last assignment wins, matching dotenv. Tolerates optional quotes around the
# value; strips a trailing CR so a CRLF-edited .env.production cannot inject one.
token="$(sed -n 's/^METRICS_AUTH_TOKEN=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')"
token="${token%\"}"; token="${token#\"}"
token="${token%\'}"; token="${token#\'}"

if [ -z "$token" ]; then
  echo "❌ METRICS_AUTH_TOKEN is empty or missing in $ENV_FILE." >&2
  echo "   The backend then serves /metrics unauthenticated — fix the token" >&2
  echo "   rather than scraping an open endpoint. See docs/metrics.md." >&2
  exit 1
fi

if [ "$token" = "__REPLACE_RANDOM__" ]; then
  echo "❌ METRICS_AUTH_TOKEN is still the placeholder __REPLACE_RANDOM__ from" >&2
  echo "   .env.production.example. Set a real one:  openssl rand -hex 24" >&2
  exit 1
fi

# If the overlay was started before this script ever ran, Docker will have
# created a *directory* at the bind-mount source. Prometheus then still starts —
# `stat` succeeds on a directory, so config load passes — and merely fails every
# scrape, which looks exactly like a bad token. Clear it so the fix is one
# command rather than a debugging session.
if [ -d "$TOKEN_FILE" ]; then
  rmdir "$TOKEN_FILE" 2>/dev/null || {
    echo "❌ $TOKEN_FILE is a non-empty directory (Docker creates one when the" >&2
    echo "   overlay starts before this script). Inspect and remove it, then rerun." >&2
    exit 1
  }
fi

umask 077
printf '%s' "$token" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

# Prometheus must be able to read it as uid 65534. chown needs root; if we are
# not root, say exactly what to run rather than silently leaving a file that
# only produces 401s later.
if [ "$(id -u)" = "0" ]; then
  chown "$PROM_UID:$PROM_UID" "$TOKEN_FILE"
  echo "✅ wrote $TOKEN_FILE (0600, owned by $PROM_UID)"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo chown "$PROM_UID:$PROM_UID" "$TOKEN_FILE"
  echo "✅ wrote $TOKEN_FILE (0600, owned by $PROM_UID)"
else
  echo "✅ wrote $TOKEN_FILE (0600, owned by $(id -un))"
  echo "⚠️  Prometheus runs as uid $PROM_UID and cannot read a 0600 file owned by"
  echo "    $(id -un). Unless your Docker maps users (Docker Desktop does), run:"
  echo "      sudo chown $PROM_UID:$PROM_UID $TOKEN_FILE"
fi

echo "   Reload Prometheus to pick up a rotated token:"
echo "     docker compose -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml restart prometheus"
