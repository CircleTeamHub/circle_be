#!/bin/sh
set -eu

autosave="${CADDY_AUTOSAVE_FILE:-/config/caddy/autosave.json}"

# A release cutover reloads Caddy with the active blue/green container name.
# Preserve only that selection across a container restart, then rebuild the
# complete config from the currently mounted Caddyfile.
if [ -s "$autosave" ]; then
  saved_upstream="$(grep -Eo 'circle-be-(blue|green):3000' "$autosave" | sort -u || true)"
  case "$saved_upstream" in
    circle-be-blue:3000|circle-be-green:3000)
      export CIRCLE_BE_UPSTREAM="$saved_upstream"
      ;;
    '')
      echo 'Caddy autosave does not identify the active blue/green backend' >&2
      exit 1
      ;;
    *)
      echo 'Caddy autosave identifies multiple active blue/green backends' >&2
      exit 1
      ;;
  esac
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
