#!/bin/sh
set -eu

autosave="${CADDY_AUTOSAVE_FILE:-/config/caddy/autosave.json}"

# A release cutover reloads Caddy with the active blue/green container name(s).
# Preserve only that selection across a container restart, then rebuild the
# complete config from the currently mounted Caddyfile.
#
# One backend per color: a single circle-be-<color>:3000. With
# CIRCLE_BE_REPLICAS > 1 the release also routes to circle-be-<color>-2..4;
# every saved endpoint must belong to the same color, and more than one of them
# selects the load-balancing pool exactly as release-deploy.sh does.
if [ -s "$autosave" ]; then
  # Sorted on the host name alone so the base container comes first — the same
  # order release-deploy.sh passes. A different order is a different config, and
  # the next release's alignment reload would drop every WebSocket for nothing.
  saved_upstream="$(grep -Eo 'circle-be-(blue|green)(-[2-4])?:3000' "$autosave" | sort -u -t: -k1,1 || true)"
  saved_colors="$(printf '%s\n' "$saved_upstream" | grep -Eo '^circle-be-(blue|green)' | sort -u || true)"
  case "$saved_colors" in
    circle-be-blue|circle-be-green)
      saved_upstream="$(printf '%s\n' "$saved_upstream" | tr '\n' ' ' | sed 's/ $//')"
      export CIRCLE_BE_UPSTREAM="$saved_upstream"
      case "$CIRCLE_BE_UPSTREAM" in
        *' '*) export CIRCLE_BE_LB=pool ;;
      esac
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
