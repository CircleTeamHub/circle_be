#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/deploy/release-deploy.sh"
# 从仓库文件读,不要写死。release-deploy.sh 强制要求
# RELEASE_SCHEMA_COMPATIBILITY == 签出树里的值,写死的话每次抬高兼容级别
# (不可逆迁移都要抬)整个套件都会红,而失败原因跟被测行为毫无关系。
REPO_SCHEMA_COMPATIBILITY="$(cat "$ROOT_DIR/deploy/SCHEMA_COMPATIBILITY")"
DIGEST_IMAGE="ghcr.io/circleteamhub/circle_be@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REAL_MV="$(command -v mv)"

last_arg() {
  local value=""
  for value in "$@"; do :; done
  printf '%s' "$value"
}

new_case() {
  unset RELEASE_DOWNTIME RELEASE_IRREVERSIBLE_MIGRATION RELEASE_MARKER_PATH RELEASE_SCHEMA_COMPATIBILITY SCHEMA_COMPATIBILITY_PATH RUNTIME_COMPATIBILITY_PATH COMPOSE_ENV_FILE APP_ENV_FILE APP_ENV_GID ENV_STAMP_FAIL KILL_AFTER_ENV_STAGE MIGRATE_FAIL CONTRACT_PROBE_STATE START_FAIL HEALTH_FAIL SMOKE_CODE SMOKE_CONTENT_TYPE CADDY_RELOAD_FAIL_TARGET PERSIST_FAIL_COLOR CADDY_NO_RATE_LIMIT || true
  CASE_DIR="$(mktemp -d)"
  export CASE_DIR
  export TEST_STATE_DIR="$CASE_DIR/services"
  export RELEASE_STATE_DIR="$CASE_DIR/release-state"
  export TEST_COMMAND_LOG="$CASE_DIR/commands.log"
  export COMPOSE_ENV_FILE="$CASE_DIR/.env"
  mkdir -p "$TEST_STATE_DIR" "$RELEASE_STATE_DIR" "$CASE_DIR/bin"
  printf 'DB_PASSWORD=test-only\n' > "$COMPOSE_ENV_FILE"
  chmod 600 "$COMPOSE_ENV_FILE"

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
# 记下临时文件在 rename **之前**的权限。它是 .env.production 的完整副本,
# 默认 umask 022 下会落成 0644 —— 那样同机其它用户在这段窗口里就能读到整份
# 生产密钥,而目标文件本身是 0600。这是唯一能观察到那个窗口的时刻。
case "${@: -1}" in
  *.env.production)
    printf 'mv %s %s\n' "${@: -2:1}" "${@: -1}" >> "$TEST_COMMAND_LOG"
    # GNU 的 -c 与 BSD 的 -f 互不认;先试 GNU(Linux CI),失败再退 BSD(macOS)。
    # BSD stat 见到 -c 会直接报错退出,不会误判成成功。
    stat -c '%a' "${@: -2:1}" 2>/dev/null > "$CASE_DIR/env-tmp-mode" ||
      stat -f '%Lp' "${@: -2:1}" > "$CASE_DIR/env-tmp-mode"
    ;;
esac
# 模拟磁盘写满/权限问题导致 Sentry release 打标失败(磁盘写满时 awk 或 mv 都
# 可能挂)。脚本开头是 set -e,所以这一步必须是 best-effort,否则会在迁移之后
# 直接退出 —— 停机模式下旧色已经停了,API 就那样一直下线。
if [ "${ENV_STAMP_FAIL:-0}" = "1" ]; then
  # Only fail the best-effort Sentry stamp. The earlier access.tmp rename is
  # the mandatory secure env installation and must still succeed.
  if [ "${@: -2:1}" = "${APP_ENV_FILE}.tmp" ] &&
    [ "${@: -1}" = "$APP_ENV_FILE" ]; then
    exit 47
  fi
fi
"$REAL_MV" "$@"
if [ "${KILL_AFTER_ENV_STAGE:-0}" = "1" ] &&
  [ "${@: -2:1}" = "$RELEASE_STATE_DIR/app-env-transaction/access.tmp" ] &&
  [ "${@: -1}" = "$APP_ENV_FILE" ]; then
  kill -KILL "$PPID"
fi
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
    RELEASE_SCHEMA_COMPATIBILITY="${RELEASE_SCHEMA_COMPATIBILITY:-$REPO_SCHEMA_COMPATIBILITY}" \
    SCHEMA_COMPATIBILITY_PATH="${SCHEMA_COMPATIBILITY_PATH:-$ROOT_DIR/deploy/SCHEMA_COMPATIBILITY}" \
    RUNTIME_COMPATIBILITY_PATH="${RUNTIME_COMPATIBILITY_PATH:-$ROOT_DIR/deploy/RELEASE_RUNTIME_COMPATIBILITY}" \
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
    COMPOSE_ENV_FILE="$COMPOSE_ENV_FILE" \
    APP_ENV_FILE="${APP_ENV_FILE:-$CASE_DIR/no-env-file}" \
    ENV_STAMP_FAIL="${ENV_STAMP_FAIL:-0}" \
    KILL_AFTER_ENV_STAGE="${KILL_AFTER_ENV_STAGE:-0}" \
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

# 八进制权限位。GNU 的 -c 与 BSD 的 -f 互不认,而这个套件本地在 macOS 跑、
# CI 在 Linux 跑 —— 先试 GNU,失败再退 BSD(BSD stat 见到 -c 会直接报错)。
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

file_inode() {
  stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1"
}

assert_mode() {
  local path="$1" expected="$2" actual
  actual="$(file_mode "$path")"
  [ "$actual" = "$expected" ] || {
    echo "expected $path to be mode $expected, got $actual" >&2
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

test_release_stamps_sentry_release_before_starting_the_new_color() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  APP_ENV_FILE="$CASE_DIR/.env.production"
  printf 'NODE_ENV=production\nSENTRY_RELEASE=circle-be@v0.0.1\n' > "$APP_ENV_FILE"
  export APP_ENV_FILE

  run_release || return 1

  # 蓝绿发布最需要「这个 bug 是哪次发版引入的」这个问题的答案,而它完全取决于
  # 每次发布都把 release 标上去。既有值必须被**替换**而不是追加 —— dotenv 取
  # 最后一个赋值,追加碰巧也能工作,但文件会随每次发版无限增长。
  grep -q '^SENTRY_RELEASE=circle-be@v1\.2\.3$' "$APP_ENV_FILE" || {
    echo "expected SENTRY_RELEASE to be stamped with the release tag" >&2
    cat "$APP_ENV_FILE" >&2
    return 1
  }
  [ "$(grep -c '^SENTRY_RELEASE=' "$APP_ENV_FILE")" = "1" ] || {
    echo "SENTRY_RELEASE was appended instead of replaced" >&2
    return 1
  }
  # 必须在起新色**之前**写好,否则新容器挂载到的还是上一版的 release。
  # 这里比对的是脚本自身输出的行号 —— 打标签是文件写入,不经过 docker,
  # 所以 assert_command_before(读 docker 命令日志)对它无效。
  local tag_line start_line
  tag_line="$(grep -n 'Tagging Sentry release circle-be@v1\.2\.3' "$CASE_DIR/release.log" | head -n 1 | cut -d: -f1)"
  start_line="$(grep -n 'Starting circle_be_green' "$CASE_DIR/release.log" | head -n 1 | cut -d: -f1)"
  [ -n "$tag_line" ] && [ -n "$start_line" ] && [ "$tag_line" -lt "$start_line" ] || {
    echo "expected the Sentry release stamp to precede starting the new color" >&2
    cat "$CASE_DIR/release.log" >&2
    return 1
  }
}

test_release_never_widens_permissions_on_the_secrets_it_rewrites() {
  # review #150(P1):打标签是「读 .env.production → 写临时文件 → mv 回去」,
  # 临时文件因此装着整份生产密钥。默认 umask 022 下它会落成 0644,在 mv 之前
  # 的这段窗口里同机任何用户都读得到 —— 而目标文件本身是 0600,等于绕过了它
  # 的权限。这里断言的是 mv **之前**那一刻的模式(由 mv 桩记录),不是事后
  # chmod 的结果:事后 chmod 补不上已经发生的泄露。
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  APP_ENV_FILE="$CASE_DIR/.env.production"
  printf 'DATABASE_URL=postgres://u:p@h/db\nJWT_SECRET=s3cr3t\n' > "$APP_ENV_FILE"
  chmod 600 "$APP_ENV_FILE"
  export APP_ENV_FILE

  run_release || return 1

  [ "$(cat "$CASE_DIR/env-tmp-mode" 2>/dev/null || true)" = "640" ] || {
    echo "temp secrets file was mode $(cat "$CASE_DIR/env-tmp-mode" 2>/dev/null || echo '<never created>') at mv time, expected 640" >&2
    return 1
  }
  assert_mode "$APP_ENV_FILE" 640 || return 1
  [ ! -e "${APP_ENV_FILE}.tmp" ] || {
    echo "expected the temp secrets copy to be gone after a successful stamp" >&2
    return 1
  }
}

test_failed_sentry_stamp_leaves_no_readable_copy_of_the_secrets() {
  # 同一条 P1 的失败路径:mv 挂掉(磁盘写满/权限)时,旧写法把一份 0644 的
  # 密钥副本永久留在部署目录里 —— 而打标签失败只是一条警告、发布照常继续,
  # 不会有人回头收拾它。
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  APP_ENV_FILE="$CASE_DIR/.env.production"
  printf 'DATABASE_URL=postgres://u:p@h/db\nJWT_SECRET=s3cr3t\n' > "$APP_ENV_FILE"
  chmod 600 "$APP_ENV_FILE"
  export APP_ENV_FILE
  ENV_STAMP_FAIL=1

  run_release || return 1

  [ ! -e "${APP_ENV_FILE}.tmp" ] || {
    echo "mv failure left a $(file_mode "${APP_ENV_FILE}.tmp") copy of the secrets behind" >&2
    return 1
  }
  # The access transaction has already installed the group-readable inode;
  # a failed observability stamp must preserve its contents and permissions.
  assert_mode "$APP_ENV_FILE" 640 || return 1
  grep -q '^JWT_SECRET=s3cr3t$' "$APP_ENV_FILE" || {
    echo "expected the original env file to survive a failed stamp untouched" >&2
    return 1
  }
}

test_release_survives_a_failed_sentry_stamp_in_downtime_mode() {
  # review #150：打标发生在迁移之后。set -e 下 awk/mv 失败会直接退出,不进
  # handle_post_migration_failure —— 而停机模式已经把旧色停了,于是 API 仅仅
  # 因为一个可观测性标签写不进去就一直下线。一个 release 标签不值得拿可用性换。
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  APP_ENV_FILE="$CASE_DIR/.env.production"
  printf 'NODE_ENV=production\n' > "$APP_ENV_FILE"
  export APP_ENV_FILE
  RELEASE_DOWNTIME=1
  ENV_STAMP_FAIL=1

  run_release || return 1

  assert_running circle_be_green || return 1
  grep -q 'could not stamp SENTRY_RELEASE' "$CASE_DIR/release.log" || {
    echo "expected a warning about the failed stamp" >&2
    cat "$CASE_DIR/release.log" >&2
    return 1
  }
}

test_release_without_env_file_still_deploys() {
  # 手动开通流程可能没有 .env.production 在预期位置;打标签失败不该阻断发布。
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"

  run_release || return 1
  assert_running circle_be_green
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

test_startup_failure_restores_legacy_env_before_live_restart() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  APP_ENV_FILE="$CASE_DIR/.env.production"
  printf 'SECRET=legacy\n' > "$APP_ENV_FILE"
  chmod 600 "$APP_ENV_FILE"
  export APP_ENV_FILE
  legacy_inode="$(file_inode "$APP_ENV_FILE")"
  RELEASE_DOWNTIME=1 START_FAIL=1

  ! run_release || return 1

  [ "$(file_inode "$APP_ENV_FILE")" = "$legacy_inode" ] || {
    echo "expected rollback to restore the original app env inode" >&2
    return 1
  }
  assert_mode "$APP_ENV_FILE" 600 || return 1
  [ "$(cat "$APP_ENV_FILE")" = 'SECRET=legacy' ] || return 1
  assert_command_before \
    "mv $RELEASE_STATE_DIR/app-env-transaction/legacy-rollback $APP_ENV_FILE" \
    'start circle_be'
}

run_staged_release_through_launcher() {
  local staged_name="$1"
  PATH="$CASE_DIR/bin:$PATH" \
    REAL_MV="$REAL_MV" \
    TARGET_SCHEMA_COMPATIBILITY="$REPO_SCHEMA_COMPATIBILITY" \
    RELEASE_TAG=v1.2.3 \
    CIRCLE_BE_IMAGE="$DIGEST_IMAGE" \
    RELEASE_DOWNTIME=0 \
    RELEASE_IRREVERSIBLE_MIGRATION=0 \
    RELEASE_MARKER_PATH="$CASE_DIR/no-marker" \
    COMPOSE_ENV_FILE="$COMPOSE_ENV_FILE" \
    APP_ENV_FILE="$APP_ENV_FILE" \
    KILL_AFTER_ENV_STAGE=0 \
    bash "$RELEASE_STATE_DIR/release-launcher.sh" "$staged_name" \
      >>"$CASE_DIR/release.log" 2>&1
}

test_interrupted_env_stage_recovers_through_launcher() {
  new_case
  printf 'running\n' > "$TEST_STATE_DIR/circle_be"
  printf 'running\n' > "$TEST_STATE_DIR/caddy"

  live_root="$CASE_DIR/live"
  RELEASE_STATE_DIR="$live_root/.release"
  export RELEASE_STATE_DIR
  mkdir -p "$RELEASE_STATE_DIR"
  printf 'circle_be\n' > "$RELEASE_STATE_DIR/active-color"
  mkdir -p "$live_root/deploy"
  cp "$ROOT_DIR/deploy/RELEASE_RUNTIME_COMPATIBILITY" "$live_root/deploy/"

  APP_ENV_FILE="$CASE_DIR/.env.production"
  printf 'SECRET=survives-crash\n' > "$APP_ENV_FILE"
  chmod 600 "$APP_ENV_FILE"
  export APP_ENV_FILE
  legacy_inode="$(file_inode "$APP_ENV_FILE")"
  KILL_AFTER_ENV_STAGE=1

  ! run_release || return 1
  [ "$(cat "$RELEASE_STATE_DIR/app-env-transaction/state")" = "staged" ] || return 1
  [ "$(file_inode "$RELEASE_STATE_DIR/app-env-transaction/legacy-rollback")" = "$legacy_inode" ] || return 1
  assert_mode "$APP_ENV_FILE" 640 || return 1

  staged_name="next-release"
  staged_root="$RELEASE_STATE_DIR/incoming/$staged_name"
  mkdir -p "$staged_root/deploy"
  cp "$ROOT_DIR/deploy/release-launcher.sh" "$RELEASE_STATE_DIR/release-launcher.sh"
  cp "$ROOT_DIR/deploy/release-deploy.sh" \
    "$ROOT_DIR/deploy/app-env-preflight.sh" \
    "$ROOT_DIR/deploy/app-env-transaction.sh" \
    "$ROOT_DIR/deploy/SCHEMA_COMPATIBILITY" \
    "$ROOT_DIR/deploy/RELEASE_RUNTIME_COMPATIBILITY" \
    "$staged_root/deploy/"
  cp "$ROOT_DIR/docker-compose.prod.yml" "$ROOT_DIR/docker-compose.release.yml" "$staged_root/"

  run_staged_release_through_launcher "$staged_name" || return 1

  grep -q 'Recovered legacy app env access from an interrupted release' "$CASE_DIR/release.log" || return 1
  [ ! -e "$RELEASE_STATE_DIR/app-env-transaction/state" ] || return 1
  [ ! -e "$staged_root" ] || return 1
  assert_mode "$APP_ENV_FILE" 640 && assert_running circle_be_green
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

test_pre_contract_release_is_rejected_before_any_deployment_action() {
  new_case
  RUNTIME_COMPATIBILITY_PATH="$CASE_DIR/no-runtime-compatibility"
  ! run_release || return 1
  grep -q 'below the trusted deployment contract minimum' "$CASE_DIR/release.log" || return 1
  [ ! -s "$TEST_COMMAND_LOG" ]
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
  grep -q "does not match checked-out schema compatibility $REPO_SCHEMA_COMPATIBILITY" "$CASE_DIR/release.log" &&
    [ ! -s "$TEST_COMMAND_LOG" ]
}

test_irreversible_release_records_minimum_schema_compatibility() {
  prepare_irreversible_case
  run_release || return 1
  [ "$(cat "$RELEASE_STATE_DIR/minimum-schema-compatibility")" = "$REPO_SCHEMA_COMPATIBILITY" ]
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
  test_release_stamps_sentry_release_before_starting_the_new_color \
  test_release_never_widens_permissions_on_the_secrets_it_rewrites \
  test_failed_sentry_stamp_leaves_no_readable_copy_of_the_secrets \
  test_release_survives_a_failed_sentry_stamp_in_downtime_mode \
  test_release_without_env_file_still_deploys \
  test_smoke_failure_restores_proxy_before_removing_standby \
  test_spa_html_response_restores_proxy_before_removing_standby \
  test_downtime_switch_failure_restores_previous_color_first \
  test_startup_failure_restores_legacy_env_before_live_restart \
  test_interrupted_env_stage_recovers_through_launcher \
  test_state_write_failure_rolls_proxy_back_before_cleanup \
  test_irreversible_confirmation_requires_downtime \
  test_marker_requires_irreversible_confirmation \
  test_pre_contract_release_is_rejected_before_any_deployment_action \
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
