#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/deploy/release-deploy.sh"
DIGEST_IMAGE="ghcr.io/circleteamhub/circle_be@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

last_arg() {
  local value=""
  for value in "$@"; do :; done
  printf '%s' "$value"
}

new_case() {
  unset RELEASE_DOWNTIME MIGRATE_FAIL SMOKE_CODE SMOKE_CONTENT_TYPE CADDY_RELOAD_FAIL_TARGET PERSIST_FAIL_COLOR || true
  CASE_DIR="$(mktemp -d)"
  export CASE_DIR
  export TEST_STATE_DIR="$CASE_DIR/services"
  export RELEASE_STATE_DIR="$CASE_DIR/release-state"
  export TEST_COMMAND_LOG="$CASE_DIR/commands.log"
  mkdir -p "$TEST_STATE_DIR" "$RELEASE_STATE_DIR" "$CASE_DIR/bin"

  cat > "$CASE_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"

last_arg() {
  local value=""
  for value in "$@"; do :; done
  printf '%s' "$value"
}

service_file() { printf '%s/%s' "$TEST_STATE_DIR" "$1"; }

if [ "${1:-}" = "compose" ]; then
  shift
  while [ "${1:-}" = "-f" ]; do shift 2; done
  subcommand="${1:-}"
  shift || true
  case "$subcommand" in
    ps)
      service="$(last_arg "$@")"
      if [ "$(cat "$(service_file "$service")" 2>/dev/null || true)" = "running" ]; then
        printf 'cid-%s\n' "$service"
      fi
      ;;
    pull|logs) ;;
    stop)
      service="$(last_arg "$@")"
      printf 'stopped\n' > "$(service_file "$service")"
      ;;
    start|up)
      service="$(last_arg "$@")"
      printf 'running\n' > "$(service_file "$service")"
      ;;
    rm)
      service="$(last_arg "$@")"
      rm -f "$(service_file "$service")"
      ;;
    run)
      [ "${MIGRATE_FAIL:-0}" != "1" ] || exit 42
      ;;
    exec)
      if [ -n "${CADDY_RELOAD_FAIL_TARGET:-}" ] &&
        printf '%s\n' "$*" | grep -q "CIRCLE_BE_UPSTREAM=$CADDY_RELOAD_FAIL_TARGET"; then
        exit 43
      fi
      ;;
    *)
      echo "unexpected docker compose command: $subcommand $*" >&2
      exit 90
      ;;
  esac
  exit 0
fi

if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then exit 0; fi
if [ "${1:-}" = "inspect" ]; then
  container="$(last_arg "$@")"
  service="${container#cid-}"
  if [ "$(cat "$(service_file "$service")" 2>/dev/null || true)" = "running" ]; then
    printf 'healthy\n'
  else
    printf 'unknown\n'
  fi
  exit 0
fi
if [ "${1:-}" = "login" ]; then exit 0; fi

echo "unexpected docker command: $*" >&2
exit 91
DOCKER
  chmod +x "$CASE_DIR/bin/docker"

  for command in flock sleep; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$CASE_DIR/bin/$command"
    chmod +x "$CASE_DIR/bin/$command"
  done
  cat > "$CASE_DIR/bin/sed" <<'SED'
#!/usr/bin/env bash
printf 'api.example.test\n'
SED
  chmod +x "$CASE_DIR/bin/sed"
  cat > "$CASE_DIR/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
headers=""
body=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -D)
      headers="$2"
      shift 2
      ;;
    -o)
      body="$2"
      shift 2
      ;;
    *) shift ;;
  esac
done
[ -z "$headers" ] || printf 'HTTP/2 %s\r\ncontent-type: %s\r\n\r\n' \
  "${SMOKE_CODE:-401}" "${SMOKE_CONTENT_TYPE:-application/json}" > "$headers"
[ -z "$body" ] || printf '%s' "${SMOKE_BODY:-{\"statusCode\":401}}" > "$body"
printf '%s' "${SMOKE_CODE:-401}"
CURL
  chmod +x "$CASE_DIR/bin/curl"
  cat > "$CASE_DIR/bin/mv" <<'MV'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${PERSIST_FAIL_COLOR:-}" ] &&
  [ "$(cat "${@: -2:1}" 2>/dev/null || true)" = "$PERSIST_FAIL_COLOR" ]; then
  exit 44
fi
exec /usr/bin/mv "$@"
MV
  chmod +x "$CASE_DIR/bin/mv"
}

run_release() {
  PATH="$CASE_DIR/bin:$PATH" \
    RELEASE_TAG=v1.2.3 \
    CIRCLE_BE_IMAGE="$DIGEST_IMAGE" \
    RELEASE_DOWNTIME="${RELEASE_DOWNTIME:-0}" \
    MIGRATE_FAIL="${MIGRATE_FAIL:-0}" \
    SMOKE_CODE="${SMOKE_CODE:-401}" \
    SMOKE_CONTENT_TYPE="${SMOKE_CONTENT_TYPE:-application/json}" \
    CADDY_RELOAD_FAIL_TARGET="${CADDY_RELOAD_FAIL_TARGET:-}" \
    PERSIST_FAIL_COLOR="${PERSIST_FAIL_COLOR:-}" \
    bash "$DEPLOY_SCRIPT" >"$CASE_DIR/release.log" 2>&1
}

assert_running() {
  [ "$(cat "$TEST_STATE_DIR/$1" 2>/dev/null || true)" = "running" ] || {
    echo "expected $1 to be running" >&2
    cat "$TEST_COMMAND_LOG" >&2
    return 1
  }
}

assert_absent() {
  [ ! -e "$TEST_STATE_DIR/$1" ] || {
    echo "expected $1 to be absent" >&2
    return 1
  }
}

assert_active_color() {
  [ "$(cat "$RELEASE_STATE_DIR/active-color" 2>/dev/null || true)" = "$1" ] || {
    echo "expected active color to be $1" >&2
    return 1
  }
}

assert_reload_target() {
  grep -q "CIRCLE_BE_UPSTREAM=$1" "$TEST_COMMAND_LOG" || {
    echo "expected Caddy reload targeting $1" >&2
    cat "$TEST_COMMAND_LOG" >&2
    return 1
  }
}

assert_command_before() {
  local first_line second_line
  first_line="$(grep -Fn "$1" "$TEST_COMMAND_LOG" | head -n 1 | cut -d: -f1)"
  second_line="$(grep -Fn "$2" "$TEST_COMMAND_LOG" | head -n 1 | cut -d: -f1)"
  if [ -z "$first_line" ] || [ -z "$second_line" ] || [ "$first_line" -ge "$second_line" ]; then
    echo "expected '$1' before '$2'" >&2
    cat "$TEST_COMMAND_LOG" >&2
    return 1
  fi
}

test_migration_failure_restores_downtime_live_color() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  RELEASE_DOWNTIME=1 MIGRATE_FAIL=1
  ! run_release || return 1
  assert_running circle_be
}

test_interrupted_rollout_preserves_recorded_live_color() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/circle_be_green"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be_green\n' > "$RELEASE_STATE_DIR/active-color"
  RELEASE_DOWNTIME=1 MIGRATE_FAIL=1
  ! run_release || return 1
  assert_running circle_be_green && assert_absent circle_be
}

test_proxy_switch_precedes_old_color_retirement() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  run_release || return 1
  assert_active_color circle_be_green &&
    assert_reload_target circle_be_green &&
    assert_command_before 'CIRCLE_BE_UPSTREAM=circle_be_green' 'stop circle_be' &&
    assert_running circle_be_green && assert_absent circle_be
}

test_smoke_failure_restores_proxy_before_removing_standby() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  SMOKE_CODE=500
  ! run_release || return 1
  assert_reload_target circle_be_green && assert_reload_target circle_be &&
    assert_active_color circle_be && assert_running circle_be &&
    assert_absent circle_be_green
}

test_spa_html_response_restores_proxy_before_removing_standby() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  SMOKE_CODE=200 SMOKE_CONTENT_TYPE=text/html
  ! run_release || return 1
  assert_reload_target circle_be_green && assert_reload_target circle_be &&
    assert_active_color circle_be && assert_running circle_be &&
    assert_absent circle_be_green
}

test_downtime_switch_failure_restores_previous_color_first() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  RELEASE_DOWNTIME=1 CADDY_RELOAD_FAIL_TARGET=circle_be_green
  ! run_release || return 1
  assert_active_color circle_be && assert_running circle_be &&
    assert_absent circle_be_green &&
    assert_command_before 'start circle_be' 'rm -sf circle_be_green'
}

test_state_write_failure_rolls_proxy_back_before_cleanup() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  PERSIST_FAIL_COLOR=circle_be_green
  ! run_release || return 1
  assert_reload_target circle_be_green && assert_reload_target circle_be &&
    assert_active_color circle_be && assert_running circle_be &&
    assert_absent circle_be_green
}

failures=0
for test_name in \
  test_migration_failure_restores_downtime_live_color \
  test_interrupted_rollout_preserves_recorded_live_color \
  test_proxy_switch_precedes_old_color_retirement \
  test_smoke_failure_restores_proxy_before_removing_standby \
  test_spa_html_response_restores_proxy_before_removing_standby \
  test_downtime_switch_failure_restores_previous_color_first \
  test_state_write_failure_rolls_proxy_back_before_cleanup; do
  if "$test_name"; then
    echo "PASS $test_name"
  else
    echo "FAIL $test_name" >&2
    failures=$((failures + 1))
  fi
done

[ "$failures" -eq 0 ] || exit 1
