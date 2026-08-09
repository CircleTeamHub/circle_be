#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/deploy/release-deploy.sh"
DIGEST_IMAGE="ghcr.io/circleteamhub/circle_be@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REAL_MV="$(command -v mv)"

last_arg() {
  local value=""
  for value in "$@"; do :; done
  printf '%s' "$value"
}

new_case() {
  unset RELEASE_DOWNTIME RELEASE_IRREVERSIBLE_MIGRATION RELEASE_MARKER_PATH RELEASE_SCHEMA_COMPATIBILITY SCHEMA_COMPATIBILITY_PATH MIGRATE_FAIL CONTRACT_PROBE_STATE START_FAIL HEALTH_FAIL SMOKE_CODE SMOKE_CONTENT_TYPE CADDY_RELOAD_FAIL_TARGET PERSIST_FAIL_COLOR CADDY_NO_RATE_LIMIT || true
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
      if [ "${HEALTH_FAIL:-0}" = "1" ] && [ "$service" != "circle_be" ] &&
        ! printf '%s\n' "$*" | grep -q -- '--status running'; then
        :
      elif [ "$(cat "$(service_file "$service")" 2>/dev/null || true)" = "running" ]; then
        printf 'cid-%s\n' "$service"
      fi
      ;;
    pull|logs) ;;
    stop)
      service="$(last_arg "$@")"
      printf 'stopped\n' > "$(service_file "$service")"
      ;;
    start)
      service="$(last_arg "$@")"
      printf 'running\n' > "$(service_file "$service")"
      ;;
    up)
      service="$(last_arg "$@")"
      [ "${START_FAIL:-0}" != "1" ] || exit 41
      printf 'running\n' > "$(service_file "$service")"
      ;;
    rm)
      service="$(last_arg "$@")"
      rm -f "$(service_file "$service")"
      ;;
    run)
      if printf '%s\n' "$*" | grep -q 'User_vipLevel_check'; then
        case "${CONTRACT_PROBE_STATE:-none}" in
          none) printf '0\n' ;;
          both) printf '4\n' ;;
          partial) printf '1\n' ;;
          error) exit 45 ;;
          *) exit 46 ;;
        esac
      else
        [ "${MIGRATE_FAIL:-0}" != "1" ] || exit 42
      fi
      ;;
    exec)
      # 部署脚本会先探一次 Caddy 是否带 rate_limit 模块(deploy/Caddyfile.admin 依赖它)。
      # 桩不认这条命令的话它恒返回空,守卫必失败,整套用例在第一步就退出。
      if printf '%s\n' "$*" | grep -q 'caddy list-modules'; then
        if [ "${CADDY_NO_RATE_LIMIT:-0}" = "1" ]; then
          printf 'http.handlers.reverse_proxy\n'
        else
          printf 'http.handlers.reverse_proxy\nhttp.handlers.rate_limit\n'
        fi
        exit 0
      fi
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
  if printf '%s\n' "$*" | grep -q '{{.Name}}'; then
    case "$service" in
      circle_be) printf '/circle-be-blue\n' ;;
      circle_be_green) printf '/circle-be-green\n' ;;
      *) exit 92 ;;
    esac
    exit 0
  fi
  if [ "${HEALTH_FAIL:-0}" = "1" ] && [ "$service" != "circle_be" ]; then
    printf 'starting\n'
  elif [ "$(cat "$(service_file "$service")" 2>/dev/null || true)" = "running" ]; then
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
exec "$REAL_MV" "$@"
MV
  chmod +x "$CASE_DIR/bin/mv"
}

run_release() {
  PATH="$CASE_DIR/bin:$PATH" \
    REAL_MV="$REAL_MV" \
    RELEASE_TAG=v1.2.3 \
    RELEASE_LAUNCHER_ACTIVE=1 \
    CIRCLE_BE_IMAGE="$DIGEST_IMAGE" \
    RELEASE_DOWNTIME="${RELEASE_DOWNTIME:-0}" \
    RELEASE_IRREVERSIBLE_MIGRATION="${RELEASE_IRREVERSIBLE_MIGRATION:-0}" \
    RELEASE_SCHEMA_COMPATIBILITY="${RELEASE_SCHEMA_COMPATIBILITY:-1}" \
    SCHEMA_COMPATIBILITY_PATH="${SCHEMA_COMPATIBILITY_PATH:-$ROOT_DIR/deploy/SCHEMA_COMPATIBILITY}" \
    RELEASE_MARKER_PATH="${RELEASE_MARKER_PATH:-$CASE_DIR/no-marker}" \
    MIGRATE_FAIL="${MIGRATE_FAIL:-0}" \
    CONTRACT_PROBE_STATE="${CONTRACT_PROBE_STATE:-none}" \
    START_FAIL="${START_FAIL:-0}" \
    HEALTH_FAIL="${HEALTH_FAIL:-0}" \
    SMOKE_CODE="${SMOKE_CODE:-401}" \
    SMOKE_CONTENT_TYPE="${SMOKE_CONTENT_TYPE:-application/json}" \
    CADDY_RELOAD_FAIL_TARGET="${CADDY_RELOAD_FAIL_TARGET:-}" \
    PERSIST_FAIL_COLOR="${PERSIST_FAIL_COLOR:-}" \
    CADDY_NO_RATE_LIMIT="${CADDY_NO_RATE_LIMIT:-0}" \
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

assert_contract_probe_ran() {
  grep -q 'User_vipLevel_check' "$TEST_COMMAND_LOG" || {
    echo "expected the target membership contract probe to run" >&2
    cat "$TEST_COMMAND_LOG" >&2
    return 1
  }
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

# deploy/Caddyfile.admin 用了 rate_limit,而官方 caddy 镜像不带这个模块。
# 镜像没换就切流的话:switch_proxy 的 caddy validate 必失败 → 每次发布都红;
# 更糟的是 caddy 一旦重启就 crash-loop(entrypoint 是 caddy run,遇未知指令起不来),
# 等于公网入口整个消失。所以这道前置检查必须真的拦得住,且不能碰任何颜色。
test_missing_caddy_rate_limit_module_aborts_before_touching_colors() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  CADDY_NO_RATE_LIMIT=1
  ! run_release || return 1
  # 现役颜色原封不动,备用颜色没被拉起来 —— 失败必须是「什么都没发生」。
  assert_running circle_be && assert_absent circle_be_green &&
    assert_active_color circle_be
}

test_caddy_rate_limit_check_is_skipped_when_caddy_is_down() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  CADDY_NO_RATE_LIMIT=1
  # caddy 没在跑时这道检查要让路,由 switch_proxy 自己的「Caddy is not running」
  # 报错负责 —— 否则错误信息会指向一个不相干的方向。
  ! run_release || return 1
  grep -q 'Caddy is not running' "$CASE_DIR/release.log"
}

test_proxy_switch_precedes_old_color_retirement() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  run_release || return 1
  assert_active_color circle_be_green &&
    assert_reload_target circle-be-green:3000 &&
    assert_command_before 'CIRCLE_BE_UPSTREAM=circle-be-green:3000' 'stop circle_be' &&
    assert_running circle_be_green && assert_absent circle_be
}

test_smoke_failure_restores_proxy_before_removing_standby() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  SMOKE_CODE=500
  ! run_release || return 1
  assert_reload_target circle-be-green:3000 && assert_reload_target circle-be-blue:3000 &&
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
  assert_reload_target circle-be-green:3000 && assert_reload_target circle-be-blue:3000 &&
    assert_active_color circle_be && assert_running circle_be &&
    assert_absent circle_be_green
}

test_downtime_switch_failure_restores_previous_color_first() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  RELEASE_DOWNTIME=1 CADDY_RELOAD_FAIL_TARGET=circle-be-green:3000
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
  assert_reload_target circle-be-green:3000 && assert_reload_target circle-be-blue:3000 &&
    assert_active_color circle_be && assert_running circle_be &&
    assert_absent circle_be_green
}

assert_not_restarted() {
  ! grep -q 'start circle_be' "$TEST_COMMAND_LOG" || {
    echo "expected previous circle_be binary not to restart" >&2
    cat "$TEST_COMMAND_LOG" >&2
    return 1
  }
}

assert_maintenance() {
  [ "$(cat "$TEST_STATE_DIR/circle_be" 2>/dev/null || true)" != "running" ] &&
    [ "$(cat "$TEST_STATE_DIR/circle_be_green" 2>/dev/null || true)" != "running" ] || {
      echo "expected both app colors to remain stopped for maintenance" >&2
      cat "$TEST_COMMAND_LOG" >&2
      return 1
    }
}

prepare_irreversible_case() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  RELEASE_DOWNTIME=1
  RELEASE_IRREVERSIBLE_MIGRATION=1
}

test_irreversible_confirmation_requires_downtime() {
  new_case
  RELEASE_DOWNTIME=0 RELEASE_IRREVERSIBLE_MIGRATION=1
  ! run_release || return 1
  grep -q 'requires RELEASE_DOWNTIME=1' "$CASE_DIR/release.log"
}

test_marker_requires_irreversible_confirmation() {
  new_case
  RELEASE_DOWNTIME=1 RELEASE_IRREVERSIBLE_MIGRATION=0
  RELEASE_MARKER_PATH="$ROOT_DIR/deploy/REQUIRES_IRREVERSIBLE_MIGRATION"
  ! run_release || return 1
  grep -q 'requires RELEASE_IRREVERSIBLE_MIGRATION=1' "$CASE_DIR/release.log"
}

test_pre_marker_release_is_rejected_after_boundary_is_recorded() {
  new_case
  printf '1\n' > "$RELEASE_STATE_DIR/minimum-schema-compatibility"
  RELEASE_SCHEMA_COMPATIBILITY=0
  SCHEMA_COMPATIBILITY_PATH="$CASE_DIR/no-schema-compatibility"
  ! run_release || return 1
  grep -q 'schema compatibility 0 is below server minimum 1' "$CASE_DIR/release.log" &&
    [ ! -s "$TEST_COMMAND_LOG" ]
}

test_release_cannot_understate_checked_out_schema_compatibility() {
  new_case
  RELEASE_SCHEMA_COMPATIBILITY=0
  ! run_release || return 1
  grep -q 'does not match checked-out schema compatibility 1' "$CASE_DIR/release.log" &&
    [ ! -s "$TEST_COMMAND_LOG" ]
}

test_irreversible_release_records_minimum_schema_compatibility() {
  prepare_irreversible_case
  run_release || return 1
  [ "$(cat "$RELEASE_STATE_DIR/minimum-schema-compatibility")" = "1" ]
}

test_irreversible_migration_failure_restores_old_binary() {
  prepare_irreversible_case
  MIGRATE_FAIL=1
  ! run_release || return 1
  assert_contract_probe_ran && assert_running circle_be
}

test_irreversible_migration_failure_restores_schema_floor_when_unapplied() {
  prepare_irreversible_case
  # 发布前无 floor(=0)。发布把它抬高到 RELEASE_SCHEMA_COMPATIBILITY 后，迁移失败且合约证明
  # 「未应用」→ 既重启旧版本，也要把 floor 原子恢复到发布前（此处 = 删除该文件）。否则被抬高
  # 的 floor 会一直卡着，后续任何旧版本的 redeploy/rollback 都被 launcher 永久拒绝。
  MIGRATE_FAIL=1
  ! run_release || return 1
  assert_contract_probe_ran && assert_running circle_be || return 1
  [ ! -e "$RELEASE_STATE_DIR/minimum-schema-compatibility" ]
}

test_irreversible_post_commit_cli_failure_stays_in_maintenance() {
  prepare_irreversible_case
  MIGRATE_FAIL=1 CONTRACT_PROBE_STATE=both
  ! run_release || return 1
  assert_contract_probe_ran && assert_maintenance && assert_not_restarted
}

test_irreversible_partial_contract_probe_stays_in_maintenance() {
  prepare_irreversible_case
  MIGRATE_FAIL=1 CONTRACT_PROBE_STATE=partial
  ! run_release || return 1
  assert_contract_probe_ran && assert_maintenance && assert_not_restarted
}

test_irreversible_contract_probe_error_stays_in_maintenance() {
  prepare_irreversible_case
  MIGRATE_FAIL=1 CONTRACT_PROBE_STATE=error
  ! run_release || return 1
  assert_contract_probe_ran && assert_maintenance && assert_not_restarted
}

test_irreversible_startup_failure_stays_in_maintenance() {
  prepare_irreversible_case
  START_FAIL=1
  ! run_release || return 1
  assert_maintenance && assert_not_restarted
}

test_irreversible_health_failure_stays_in_maintenance() {
  prepare_irreversible_case
  HEALTH_FAIL=1
  ! run_release || return 1
  assert_maintenance && assert_not_restarted
}

test_irreversible_proxy_failure_stays_in_maintenance() {
  prepare_irreversible_case
  CADDY_RELOAD_FAIL_TARGET=circle-be-green:3000
  ! run_release || return 1
  assert_maintenance && assert_not_restarted
}

test_irreversible_state_failure_stays_in_maintenance() {
  prepare_irreversible_case
  PERSIST_FAIL_COLOR=circle_be_green
  ! run_release || return 1
  assert_maintenance && assert_not_restarted
}

test_irreversible_smoke_failure_stays_in_maintenance() {
  prepare_irreversible_case
  SMOKE_CODE=500
  ! run_release || return 1
  assert_maintenance && assert_not_restarted
}

failures=0
for test_name in \
  test_migration_failure_restores_downtime_live_color \
  test_interrupted_rollout_preserves_recorded_live_color \
  test_missing_caddy_rate_limit_module_aborts_before_touching_colors \
  test_caddy_rate_limit_check_is_skipped_when_caddy_is_down \
  test_proxy_switch_precedes_old_color_retirement \
  test_smoke_failure_restores_proxy_before_removing_standby \
  test_spa_html_response_restores_proxy_before_removing_standby \
  test_downtime_switch_failure_restores_previous_color_first \
  test_state_write_failure_rolls_proxy_back_before_cleanup \
  test_irreversible_confirmation_requires_downtime \
  test_marker_requires_irreversible_confirmation \
  test_pre_marker_release_is_rejected_after_boundary_is_recorded \
  test_release_cannot_understate_checked_out_schema_compatibility \
  test_irreversible_release_records_minimum_schema_compatibility \
  test_irreversible_migration_failure_restores_old_binary \
  test_irreversible_migration_failure_restores_schema_floor_when_unapplied \
  test_irreversible_post_commit_cli_failure_stays_in_maintenance \
  test_irreversible_partial_contract_probe_stays_in_maintenance \
  test_irreversible_contract_probe_error_stays_in_maintenance \
  test_irreversible_startup_failure_stays_in_maintenance \
  test_irreversible_health_failure_stays_in_maintenance \
  test_irreversible_proxy_failure_stays_in_maintenance \
  test_irreversible_state_failure_stays_in_maintenance \
  test_irreversible_smoke_failure_stays_in_maintenance; do
  if "$test_name"; then
    echo "PASS $test_name"
  else
    echo "FAIL $test_name" >&2
    failures=$((failures + 1))
  fi
done

[ "$failures" -eq 0 ] || exit 1
