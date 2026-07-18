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
TOKEN_FILE="${TOKEN_FILE:-monitoring/prometheus/metrics_token}"
PROM_UID="${PROM_UID:-65534}"
PROM_GID="${PROM_GID:-$PROM_UID}"
SUDO="${SUDO:-sudo}"

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

token_dir="$(dirname "$TOKEN_FILE")"
token_name="$(basename "$TOKEN_FILE")"
umask 077
temp_file="$(mktemp "$token_dir/.${token_name}.tmp.XXXXXX")"
staged_file="${temp_file}.staged"

cleanup() {
  rm -f "$temp_file"
  if [ -e "$staged_file" ]; then
    if [ "$(id -u)" = "0" ]; then
      rm -f "$staged_file"
    elif command -v "$SUDO" >/dev/null 2>&1 && "$SUDO" -n true 2>/dev/null; then
      "$SUDO" -n rm -f "$staged_file"
    fi
  fi
}
trap cleanup EXIT

printf '%s' "$token" > "$temp_file"
chmod 600 "$temp_file"

# Never truncate TOKEN_FILE as the deployment user: after the first sync it is
# deliberately 0600 and owned by Prometheus. Stage the new inode with the final
# ownership, then replace the path atomically with privileged rename.
if [ "$(id -u)" = "0" ]; then
  install -m 600 -o "$PROM_UID" -g "$PROM_GID" "$temp_file" "$staged_file"
  mv -f "$staged_file" "$TOKEN_FILE"
elif command -v "$SUDO" >/dev/null 2>&1 && "$SUDO" -n true 2>/dev/null; then
  "$SUDO" -n install -m 600 -o "$PROM_UID" -g "$PROM_GID" \
    "$temp_file" "$staged_file"
  "$SUDO" -n mv -f "$staged_file" "$TOKEN_FILE"
else
  echo "❌ cannot install $TOKEN_FILE as uid/gid $PROM_UID:$PROM_GID." >&2
  echo "   Configure passwordless sudo for install and mv, or run this script as root." >&2
  exit 1
fi

echo "✅ wrote $TOKEN_FILE (0600, owned by $PROM_UID:$PROM_GID)"

echo "   Recreate Prometheus to bind the rotated token inode:"
echo "     docker compose -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml up -d --force-recreate prometheus"
