#!/usr/bin/env bash
# 服务器端蓝绿发版目标脚本。只能由 rsync 树外的持久 launcher 在持锁状态下调用;
# workflow 和手工回滚入口见 DEPLOY.md §6。
#
# 环境变量:
#   RELEASE_TAG        必填,v 开头的版本 tag
#   CIRCLE_BE_IMAGE    必填,要部署的不可变镜像引用
#   GHCR_USER/TOKEN    可选,拉私有镜像用(CI 传 job 级临时 GITHUB_TOKEN;
#                      手动回滚时镜像通常还在本地缓存,可不传)
#   RELEASE_DOWNTIME=1 可选,停机模式:先停旧版本再跑迁移。仅用于
#                      不向后兼容的迁移;默认蓝绿模式要求迁移向后兼容
#                      (旧代码 + 新 schema 需共存到切换完成)。
#   RELEASE_IRREVERSIBLE_MIGRATION=1 可选,确认本次迁移越过旧二进制
#                      回滚下限。必须同时启用 RELEASE_DOWNTIME=1。
#   RELEASE_SCHEMA_COMPATIBILITY 必填(由 launcher 传入),发布镜像支持的 schema
#                      兼容级别。
#
# 发版契约:
# - 只接受 v* 版本 tag;
# - 只动应用面(circle_be 蓝/绿 + 一次性 migrate);postgres/redis/minio/
#   caddy/admin_web 属开通期资产(DEPLOY.md §4),发版不 pull 不重建;
# - 本机永不构建镜像(--no-build);
# - 顺序:锁 → 拉镜像 → 备份数据库 → 迁移 → 起新色 → 容器健康门禁 →
#   校验/切换代理 → 公网烟测 → 停删旧色;任何一步失败都让 CI 变红,
#   烟测失败会自动把代理切回旧版本并清理新色。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${RELEASE_LAUNCHER_ACTIVE:-0}" != "1" ]; then
  echo "release-deploy.sh must be executed by the persistent release launcher" >&2
  exit 1
fi

for name in RELEASE_TAG CIRCLE_BE_IMAGE; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
done

if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Refusing to deploy invalid version tag: $RELEASE_TAG" >&2
  exit 1
fi

if [[ ! "$CIRCLE_BE_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "CIRCLE_BE_IMAGE must be an immutable ghcr.io image digest" >&2
  exit 1
fi

RELEASE_STATE_DIR="${RELEASE_STATE_DIR:-.release}"
SCHEMA_COMPATIBILITY_PATH="${SCHEMA_COMPATIBILITY_PATH:-deploy/SCHEMA_COMPATIBILITY}"
RUNTIME_COMPATIBILITY_PATH="${RUNTIME_COMPATIBILITY_PATH:-deploy/RELEASE_RUNTIME_COMPATIBILITY}"
MINIMUM_RELEASE_RUNTIME_COMPATIBILITY=1
MINIMUM_SCHEMA_COMPATIBILITY_PATH="$RELEASE_STATE_DIR/minimum-schema-compatibility"
checked_out_runtime_compatibility=0
if [ -e "$RUNTIME_COMPATIBILITY_PATH" ]; then
  checked_out_runtime_compatibility="$(cat "$RUNTIME_COMPATIBILITY_PATH")"
  if [[ ! "$checked_out_runtime_compatibility" =~ ^[0-9]+$ ]]; then
    echo "Invalid release runtime compatibility: $RUNTIME_COMPATIBILITY_PATH" >&2
    exit 1
  fi
fi
if (( checked_out_runtime_compatibility < MINIMUM_RELEASE_RUNTIME_COMPATIBILITY )); then
  echo "Release runtime compatibility $checked_out_runtime_compatibility is below the trusted deployment contract minimum $MINIMUM_RELEASE_RUNTIME_COMPATIBILITY." >&2
  echo "This application tag cannot safely use the current Compose, health-check, and proxy contract." >&2
  exit 1
fi
checked_out_schema_compatibility=0
if [ -e "$SCHEMA_COMPATIBILITY_PATH" ]; then
  checked_out_schema_compatibility="$(cat "$SCHEMA_COMPATIBILITY_PATH")"
  if [[ ! "$checked_out_schema_compatibility" =~ ^[0-9]+$ ]]; then
    echo "Invalid checked-out schema compatibility: $SCHEMA_COMPATIBILITY_PATH" >&2
    exit 1
  fi
fi
if [ -z "${RELEASE_SCHEMA_COMPATIBILITY:-}" ]; then
  RELEASE_SCHEMA_COMPATIBILITY="$checked_out_schema_compatibility"
fi
if [[ ! "$RELEASE_SCHEMA_COMPATIBILITY" =~ ^[0-9]+$ ]]; then
  echo "Invalid release schema compatibility: $RELEASE_SCHEMA_COMPATIBILITY" >&2
  exit 1
fi
if (( RELEASE_SCHEMA_COMPATIBILITY != checked_out_schema_compatibility )); then
  echo "Release schema compatibility $RELEASE_SCHEMA_COMPATIBILITY does not match checked-out schema compatibility $checked_out_schema_compatibility." >&2
  exit 1
fi
minimum_schema_compatibility=0
minimum_schema_compatibility_existed=0
if [ -e "$MINIMUM_SCHEMA_COMPATIBILITY_PATH" ]; then
  minimum_schema_compatibility_existed=1
  minimum_schema_compatibility="$(cat "$MINIMUM_SCHEMA_COMPATIBILITY_PATH")"
  if [[ ! "$minimum_schema_compatibility" =~ ^[0-9]+$ ]]; then
    echo "Invalid server schema boundary: $MINIMUM_SCHEMA_COMPATIBILITY_PATH" >&2
    exit 1
  fi
fi
if (( RELEASE_SCHEMA_COMPATIBILITY < minimum_schema_compatibility )); then
  echo "Release schema compatibility $RELEASE_SCHEMA_COMPATIBILITY is below server minimum $minimum_schema_compatibility; restore and verify the database before explicitly clearing $MINIMUM_SCHEMA_COMPATIBILITY_PATH." >&2
  exit 1
fi

RELEASE_MARKER_PATH="${RELEASE_MARKER_PATH:-deploy/REQUIRES_IRREVERSIBLE_MIGRATION}"
if [ "${RELEASE_IRREVERSIBLE_MIGRATION:-0}" = "1" ] && [ "${RELEASE_DOWNTIME:-0}" != "1" ]; then
  echo "RELEASE_IRREVERSIBLE_MIGRATION=1 requires RELEASE_DOWNTIME=1" >&2
  exit 1
fi
if [ -e "$RELEASE_MARKER_PATH" ] && [ "${RELEASE_IRREVERSIBLE_MIGRATION:-0}" != "1" ]; then
  echo "$RELEASE_MARKER_PATH requires RELEASE_IRREVERSIBLE_MIGRATION=1" >&2
  exit 1
fi

# 单飞锁:同一时刻只允许一个发版(CI 队列 + 手动操作重叠时的兜底)。
exec 200>/tmp/circle-be-release.lock
if ! flock -n 200; then
  echo "Another release is in progress (lock: /tmp/circle-be-release.lock)" >&2
  exit 1
fi

COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env}"
APP_ENV_FILE="${APP_ENV_FILE:-.env.production}"
resolved_app_env_gid=""
release_docker_config=""
. deploy/app-env-preflight.sh
. deploy/app-env-transaction.sh
initialize_app_env_transaction

prepare_compose_app_env_gid "$COMPOSE_ENV_FILE"
recover_interrupted_app_env_transaction

# Keep the env-file rename transaction recoverable when the SSH session drops,
# the workflow times out, or the process receives TERM/INT. Before a successful
# cutover, a reversible exit restores the exact legacy inode; after the
# no-rollback boundary or a completed cutover, only the obsolete backup is
# removed. This trap also owns cleanup of the temporary Docker credential store.
cleanup_release_on_exit() {
  local status=$? persisted_transaction_state=""
  trap - EXIT INT TERM HUP
  if [ -e "$APP_ENV_TRANSACTION_PATH" ]; then
    persisted_transaction_state="$(cat "$APP_ENV_TRANSACTION_PATH" 2>/dev/null || true)"
  fi
  if [ "$app_env_transaction_active" = "1" ] && [ -n "$app_env_staged_file" ]; then
    rm -f "$app_env_staged_file"
    app_env_staged_file=""
  fi
  if [ -n "$legacy_app_env_backup" ] && [ -e "$legacy_app_env_backup" ]; then
    if [ "$app_env_transaction_committed" = "1" ] ||
      [ "$persisted_transaction_state" = "committed" ] ||
      { [ "${RELEASE_IRREVERSIBLE_MIGRATION:-0}" = "1" ] &&
        [ "${irreversible_migration_applied:-0}" = "1" ] &&
        [ -e "$APP_ENV_FILE" ]; }; then
      commit_app_env_transaction || true
    else
      restore_legacy_app_env_access || true
    fi
  fi
  if [ -n "$release_docker_config" ]; then
    rm -rf "$release_docker_config"
  fi
  exit "$status"
}
trap cleanup_release_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

compose() {
  docker compose -f docker-compose.prod.yml -f docker-compose.release.yml "$@"
}

running() {
  compose ps -q --status running "$1" 2>/dev/null || true
}

container_upstream() {
  local cid name
  cid="$(running "$1")"
  if [ -z "$cid" ]; then
    echo "$1 has no running container" >&2
    return 1
  fi
  if ! name="$(docker inspect --format '{{.Name}}' "$cid")" || [ -z "$name" ]; then
    echo "Could not resolve the container endpoint for $1" >&2
    return 1
  fi
  printf '%s:3000\n' "${name#/}"
}

recorded_live_color() {
  cat "$RELEASE_STATE_DIR/active-color" 2>/dev/null || true
}

persist_active_color() {
  local color="$1" temp
  mkdir -p "$RELEASE_STATE_DIR"
  temp="$RELEASE_STATE_DIR/active-color.tmp.$$"
  printf '%s\n' "$color" > "$temp"
  mv -f "$temp" "$RELEASE_STATE_DIR/active-color"
}

persist_minimum_schema_compatibility() {
  local target="$1" current temp
  current=0
  if [ -e "$MINIMUM_SCHEMA_COMPATIBILITY_PATH" ]; then
    current="$(cat "$MINIMUM_SCHEMA_COMPATIBILITY_PATH")"
  fi
  if (( target <= current )); then
    return 0
  fi
  mkdir -p "$RELEASE_STATE_DIR"
  temp="$MINIMUM_SCHEMA_COMPATIBILITY_PATH.tmp.$$"
  printf '%s\n' "$target" > "$temp"
  mv -f "$temp" "$MINIMUM_SCHEMA_COMPATIBILITY_PATH"
}

# 迁移被证明未应用（DB 仍是发布前的旧 schema）时，把发布前抬高的 floor 原子恢复到发布前的
# 值。否则被抬高的 floor 会一直卡着：后续任何旧版本的 redeploy/rollback 都会被 launcher 以
# 「低于 server 最低兼容」永久拒绝，直到运维手工改状态文件。发布前不存在则删掉该文件还原。
restore_minimum_schema_compatibility_floor() {
  local temp
  if [ "$minimum_schema_compatibility_existed" = "1" ]; then
    mkdir -p "$RELEASE_STATE_DIR"
    temp="$MINIMUM_SCHEMA_COMPATIBILITY_PATH.tmp.$$"
    printf '%s\n' "$minimum_schema_compatibility" > "$temp"
    mv -f "$temp" "$MINIMUM_SCHEMA_COMPATIBILITY_PATH"
  else
    rm -f "$MINIMUM_SCHEMA_COMPATIBILITY_PATH"
  fi
}

# deploy/Caddyfile.admin 用了 rate_limit，而官方 caddy 镜像不带这个模块（本仓库用
# Dockerfile.caddy 自行构建）。镜像没换而配置已同步过去时：switch_proxy 的
# `caddy validate` 必失败 → 拒绝切流 → 之后每一次发布都红；更糟的是 caddy 一旦因
# 任何原因重启（宿主机重启、docker 升级）就会 crash-loop —— entrypoint 是
# `caddy run`，遇到未知指令根本起不来，等于公网入口整个消失。
#
# 所以提前查一次，并直接给出可执行的修复命令，而不是让人对着 validate 的报错猜。
assert_caddy_has_rate_limit() {
  # caddy 没在跑：交给 switch_proxy 自己的「Caddy is not running」检查处理。
  [ -n "$(running caddy)" ] || return 0
  if compose exec -T caddy caddy list-modules 2>/dev/null |
    grep -qx 'http\.handlers\.rate_limit'; then
    return 0
  fi
  cat >&2 <<'CADDY_MSG'
The running Caddy has no rate_limit module, but deploy/Caddyfile.admin requires it.
Leaving it as-is blocks every future release and makes any Caddy restart crash-loop.
Rebuild and recreate Caddy once, then re-run this deploy:
  docker compose -f docker-compose.prod.yml build caddy
  docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
CADDY_MSG
  return 1
}

switch_proxy() {
  local target
  target="$(container_upstream "$1")" || return 1
  if [ -z "$(running caddy)" ]; then
    echo "Caddy is not running; refusing to change the active app color." >&2
    return 1
  fi
  if ! compose exec -T -e "CIRCLE_BE_UPSTREAM=$target" caddy \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo "Caddy validation failed for upstream $target." >&2
    return 1
  fi
  compose exec -T -e "CIRCLE_BE_UPSTREAM=$target" caddy \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
}

# 登录凭证放进一次性的隔离 DOCKER_CONFIG,不污染主机默认凭证存储。
if [ -n "${GHCR_TOKEN:-}" ]; then
  release_docker_config="$(mktemp -d)"
  DOCKER_CONFIG="$release_docker_config"
  export DOCKER_CONFIG
  printf '%s' "$GHCR_TOKEN" |
    docker login ghcr.io -u "${GHCR_USER:?GHCR_USER is required when GHCR_TOKEN is set}" --password-stdin
fi

export CIRCLE_BE_IMAGE

# 放在拉镜像之前：这是纯本地检查，几秒出结果，没必要等到切流那一步（几分钟后）
# 才发现代理根本不可能被 reload。
assert_caddy_has_rate_limit || exit 1

echo "==> Pulling release image: $CIRCLE_BE_IMAGE"
if ! compose pull --quiet circle_be migrate; then
  echo "warning: pull failed; falling back to local image cache"
fi
if ! docker image inspect "$CIRCLE_BE_IMAGE" >/dev/null 2>&1; then
  echo "Image not available locally and pull failed: $CIRCLE_BE_IMAGE" >&2
  exit 1
fi

# ── 识别在役颜色 ────────────────────────────────────────────────
blue="$(running circle_be)"
green="$(running circle_be_green)"
proxy_aligned=0
if [ -n "$blue" ] && [ -n "$green" ]; then
  recorded_live="$(recorded_live_color)"
  case "$recorded_live" in
    circle_be)
      live=circle_be standby=circle_be_green
      ;;
    circle_be_green)
      live=circle_be_green standby=circle_be
      ;;
    *)
      echo "Both app colors are running, but active-color state is missing or invalid." >&2
      echo "Refusing to guess which container is live; repair $RELEASE_STATE_DIR/active-color." >&2
      exit 1
      ;;
  esac
  echo "warning: both colors running; preserving recorded live color $live"
  if ! switch_proxy "$live"; then
    echo "Failed to restore Caddy to $live; leaving both colors running." >&2
    exit 1
  fi
  proxy_aligned=1
  persist_active_color "$live"
  compose rm -sf "$standby"
  if [ "$standby" = "circle_be" ]; then
    blue=""
  else
    green=""
  fi
fi
if [ -n "$blue" ]; then
  live=circle_be standby=circle_be_green
elif [ -n "$green" ]; then
  live=circle_be_green standby=circle_be
else
  live="" standby=circle_be
fi

if [ -z "$live" ] && [ -z "$(running postgres)" ]; then
  echo "Stack not initialized (no app color and postgres is down)." >&2
  echo "Run the DEPLOY.md §4 bootstrap first; releases only update a live stack." >&2
  exit 1
fi
if [ -n "$live" ]; then
  if [ "$proxy_aligned" != "1" ] && ! switch_proxy "$live"; then
    echo "Failed to align Caddy with live color $live; refusing to deploy." >&2
    exit 1
  fi
  persist_active_color "$live"
fi
echo "==> Live color: ${live:-none}; deploying $RELEASE_TAG to: $standby"

wait_healthy() {
  local svc="$1" timeout="$2" cid status deadline
  cid="$(compose ps -q "$svc" 2>/dev/null | head -n 1)"
  if [ -z "$cid" ]; then
    echo "$svc has no container to wait for" >&2
    return 1
  fi
  deadline=$(($(date +%s) + timeout))
  while :; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "$svc did not become healthy within ${timeout}s (last status: $status)" >&2
      return 1
    fi
    sleep 5
  done
}

ensure_live() {
  if [ -z "$live" ]; then
    return 1
  fi
  if ! restore_legacy_app_env_access; then
    echo "CRITICAL: previous app env access could not be restored" >&2
    return 1
  fi
  if [ -z "$(running "$live")" ] && ! compose start "$live"; then
    echo "CRITICAL: previous version $live could not be restarted" >&2
    return 1
  fi
  if ! wait_healthy "$live" 120; then
    echo "CRITICAL: previous version $live did not return healthy" >&2
    return 1
  fi
}

# Before the new color is healthy, only downtime mode has stopped the live app.
# Reversible failures may restore it; irreversible failures call this only after
# the database contract is positively proven unapplied.
restore_live() {
  if [ -n "$live" ]; then
    restore_legacy_app_env_access || return 1
  else
    discard_legacy_app_env_backup || return 1
  fi
  if [ "${RELEASE_DOWNTIME:-0}" != "1" ] || [ -z "$live" ]; then
    return 0
  fi

  echo "==> Restarting previous version $live (the schema may already be migrated)" >&2
  ensure_live || return 1
  echo "==> Previous version $live restored" >&2
}

irreversible_migration_applied=0

irreversible_boundary_crossed() {
  [ "${RELEASE_IRREVERSIBLE_MIGRATION:-0}" = "1" ] &&
    [ "$irreversible_migration_applied" = "1" ]
}

enter_irreversible_maintenance() {
  echo "CRITICAL: irreversible contract is applied or could not be proven unapplied; refusing to restart the previous binary." >&2
  echo "Keeping the service in maintenance for a forward fix or database restore." >&2
  if [ -n "${standby:-}" ] && [ -n "$(running "$standby")" ]; then
    compose stop "$standby" || true
  fi
  if [ -n "${live:-}" ] && [ -n "$(running "$live")" ]; then
    compose stop "$live" || true
  fi
  # 旧二进制已明确不可回滚；不再保留可能沿用历史宽松权限的密钥副本。
  commit_app_env_transaction || true
}

probe_irreversible_contract_state() {
  local constraint_count probe_script
  probe_script=$(cat <<'NODE'
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT count(*)::int AS count
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS table_record
        ON table_record.oid = constraint_record.conrelid
      JOIN pg_namespace AS schema_record
        ON schema_record.oid = table_record.relnamespace
      WHERE schema_record.nspname = current_schema()
        AND constraint_record.contype = 'c'
        AND constraint_record.convalidated
        AND (
          (table_record.relname = 'User'
            AND constraint_record.conname = 'User_vipLevel_check')
          OR
          (table_record.relname = 'Circle'
            AND constraint_record.conname = 'Circle_joinVipRestriction_check')
          OR
          (table_record.relname = 'CirclePost'
            AND constraint_record.conname = 'CirclePost_vipRestriction_check')
          OR
          (table_record.relname = 'CirclePost'
            AND constraint_record.conname = 'CirclePost_signupVipRestriction_check')
        )
    `);
    process.stdout.write(String(result.rows[0].count));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`membership contract probe failed: ${error.message}`);
  process.exit(1);
});
NODE
)

  if ! constraint_count="$(compose run --rm --no-deps migrate node -e "$probe_script")"; then
    printf 'ambiguous\n'
    return 0
  fi

  case "$constraint_count" in
    0) printf 'unapplied\n' ;;
    4) printf 'applied\n' ;;
    *) printf 'ambiguous\n' ;;
  esac
}

handle_irreversible_migration_command_failure() {
  local contract_state
  contract_state="$(probe_irreversible_contract_state)"
  case "$contract_state" in
    unapplied)
      echo "Irreversible contract is proven unapplied; restoring the previous binary and the pre-release schema floor." >&2
      restore_minimum_schema_compatibility_floor || true
      restore_live || true
      ;;
    applied)
      irreversible_migration_applied=1
      echo "Migration command failed after the irreversible contract was applied." >&2
      enter_irreversible_maintenance
      ;;
    *)
      echo "Migration command failed and contract state is ambiguous." >&2
      enter_irreversible_maintenance
      ;;
  esac
}

handle_post_migration_failure() {
  if irreversible_boundary_crossed; then
    enter_irreversible_maintenance
  else
    restore_live || true
  fi
}

# 走 Caddy 的公网烟测:外部视角验证 TLS/反代/应用整条链路。auth/me 是
# 已知存在的路由;未带鉴权时 401/403 是健康响应,404 必须视为路由故障。
smoke() {
  local api_domain attempt code headers body
  api_domain="$(sed -n 's/^API_DOMAIN=//p' .env | tail -n 1)"
  if [ -z "$api_domain" ]; then
    echo "API_DOMAIN is unset; public smoke verification is mandatory" >&2
    return 1
  fi
  if [ -z "$(running caddy)" ]; then
    echo "caddy is not running; public smoke verification cannot proceed" >&2
    return 1
  fi

  headers="$(mktemp)"
  body="$(mktemp)"
  for attempt in $(seq 1 12); do
    : >"$headers"
    : >"$body"
    if ! code="$(curl -m 5 -sS -H 'Accept: application/json' -D "$headers" -o "$body" \
      -w '%{http_code}' "https://$api_domain/api/v1/auth/me")"; then
      code=000
    fi
    case "$code" in
      401|403)
        if grep -Eqi '^content-type:[[:space:]]*application/(problem\+)?json([;[:space:]]|$)' "$headers"; then
          echo "public smoke ok (HTTP $code JSON via https://$api_domain)"
          rm -f "$headers" "$body"
          return 0
        fi
        ;;
    esac
    sleep 5
  done
  echo "public smoke failed after 12 attempts (last HTTP $code; expected 401/403 JSON)" >&2
  head -c 500 "$body" >&2 || true
  rm -f "$headers" "$body"
  return 1
}

# 异地备份的函数定义(只定义,不执行)。未配置目标存储桶时
# ship_backup_offsite 直接返回,行为与引入它之前完全一致。
#
# 必须带存在性判断:裸 source 在 set -e 下会让缺文件直接中止整个发版,而且是在
# 下面的 pg_dump 安全网之前 —— 一个可选功能不该有能力搞挂根本没打算用它的发版
# (只 rsync 了部分文件、热修时单独拷脚本等)。缺失时降级为 no-op 并告警。
if [ -r deploy/offsite-backup.sh ]; then
  # shellcheck source=deploy/offsite-backup.sh
  . deploy/offsite-backup.sh
else
  echo "WARNING: deploy/offsite-backup.sh not found; off-host backup copy disabled" >&2
  ship_backup_offsite() { :; }
fi

# ── 迁移前先做数据库备份(pg_dump,保留最近 7 份)────────────────
if [ -n "$(running postgres)" ]; then
  backup_dir="$HOME/circle_be_backups"
  mkdir -p "$backup_dir"
  backup_file="$backup_dir/circle-$(date +%Y%m%d-%H%M%S)-pre-$RELEASE_TAG.sql.gz"
  echo "==> Backing up database to $backup_file"
  compose exec -T postgres pg_dump -U circle -d circle | gzip > "$backup_file"
  ls -1t "$backup_dir"/circle-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f

  # 再送一份加密副本到主机之外。本地备份(上面几行)是迁移安全网,不受影响;
  # 这一步防的是整台 VPS 丢失。失败只告警不中断发版 —— 理由见
  # deploy/offsite-backup.sh 里 ship_backup_offsite 的注释。
  ship_backup_offsite "$backup_file" || true
fi

# ── 停机模式:先停旧色再迁移(仅不向后兼容迁移使用)──────────────
if [ "${RELEASE_DOWNTIME:-0}" = "1" ] && [ -n "$live" ]; then
  echo "==> Downtime mode: stopping $live before migration"
  compose stop "$live"
fi

# Persist the boundary before the irreversible command. If the process is
# interrupted after the database changes, a later pre-marker release still
# fails closed even though its checked-out tree lacks this script.
if [ "${RELEASE_IRREVERSIBLE_MIGRATION:-0}" = "1" ]; then
  if ! persist_minimum_schema_compatibility "$RELEASE_SCHEMA_COMPATIBILITY"; then
    echo "Could not persist the irreversible schema compatibility boundary." >&2
    restore_live || true
    exit 1
  fi
fi

# ── 用发布镜像跑迁移 ────────────────────────────────────────────
# 默认(蓝绿)模式下旧版本仍在服务:迁移必须向后兼容(expand/contract)。
echo "==> Running prisma migrate deploy from $CIRCLE_BE_IMAGE"
if ! compose run --rm migrate; then
  echo "Migration failed; the database may require manual inspection" >&2
  if [ "${RELEASE_IRREVERSIBLE_MIGRATION:-0}" = "1" ]; then
    handle_irreversible_migration_command_failure
  else
    restore_live || true
  fi
  exit 1
fi
irreversible_migration_applied=1

if ! stage_app_env_for_new_container; then
  echo "Could not prepare app env access for the new container" >&2
  handle_post_migration_failure
  exit 1
fi
if irreversible_boundary_crossed; then
  commit_app_env_transaction
fi

# ── 给这次发布盖上 Sentry release 标签 ─────────────────────────
# 没有 release,Sentry 里就没法回答「这个 bug 是哪次发版引入的」,regression
# 检测退化、release health 完全不可用 —— 而蓝绿发布恰恰是最需要按版本归因的
# 场景。RELEASE_TAG 已在脚本开头按 vX.Y.Z 校验过,直接用它做 release 标识,
# 比 git sha 更贴合「部署出去的是哪个制品」。
#
# 写进 .env.production(应用只读挂载它,getServerConfig 从这里读,不看
# 容器环境变量)。已在运行的旧色早已把配置读进内存,不受影响。
#
# 注意:发布失败回滚后,旧色若因任何原因重启,会读到这个新的 release 值而跑着
# 旧代码。这只影响归因准确性,不影响功能;真正回滚时应重跑对应版本的发布。
set_release_env_value() {
  local file="$1" key="$2" value="$3" gid="$4"
  local tmp="${file}.tmp"
  # 临时文件装的是**整份生产密钥**(awk 把 $file 原样抄一遍)。直接
  # `awk ... > "$tmp"` 会用部署机常见的 umask 022 建出 0644,于是从写入到
  # mv 的这段窗口里同机任何用户都读得到 —— 而 .env.production 本身是 0600,
  # 等于绕过了它的权限。
  #
  # 先删再建:残留的旧 .env.production.tmp(上一次发布被 Ctrl-C 掐断等)会让
  # `>` 只做截断、保留它原来的宽松权限,umask 对已存在的文件不起作用。
  # 默认 ACL 不受 umask 限制，所以必须趁文件为空时清掉。组和最终权限也都在
  # rename 前设置；任何权限命令失败都只删除临时文件，正式配置仍是可读的 0640。
  rm -f "$tmp" || return 1
  (umask 077 && : > "$tmp") || return 1
  clear_app_env_acl "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  awk -v key="$key" -v value="$value" '
    BEGIN { prefix = key "="; replaced = 0 }
    index($0, prefix) == 1 {
      if (!replaced) print prefix value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print prefix value }
  ' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  chgrp "$gid" "$tmp" || { rm -f "$tmp"; return 1; }
  clear_app_env_acl "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 640 "$tmp" || { rm -f "$tmp"; return 1; }
  # 任何一步失败都必须把临时文件带走,否则密钥副本会一直躺在部署目录里 ——
  # 打标签失败只是警告、发布照常继续,不会有人回头来收拾它。
  mv "$tmp" "$file" || { rm -f "$tmp"; return 1; }
}

# 路径可覆盖,理由与 RELEASE_STATE_DIR / RELEASE_MARKER_PATH 相同:脚本第 28 行
# 就 cd 到仓库根,契约测试也在仓库根跑 —— 写死路径会让跑一次测试就改掉开发机上
# 真实的 .env.production。
# 尽力而为,失败绝不中断发版。脚本开头是 set -e:awk/mv 因磁盘写满或权限问题
# 失败的话,会在迁移之后、进入 handle_post_migration_failure 之前直接退出 ——
# 在 RELEASE_DOWNTIME=1 模式下旧色已经停了,于是 API 仅仅因为一个可观测性标签
# 写不进去而一直下线。一个 release 标签不值得拿可用性去换。
if [ -f "$APP_ENV_FILE" ]; then
  echo "==> Tagging Sentry release circle-be@$RELEASE_TAG"
  # 临时文件在写入期间是 0600；原子替换前改为 0640，让只加入
  # APP_ENV_GID 的非 root 容器用户读取 bind mount。正式文件替换后不再
  # 执行可能失败的权限修改。
  if ! can_rewrite_app_env_acl_safely; then
    echo "WARNING: setfacl is unavailable; preserving $APP_ENV_FILE and skipping SENTRY_RELEASE stamp." >&2
  elif set_release_env_value "$APP_ENV_FILE" SENTRY_RELEASE "circle-be@$RELEASE_TAG" \
    "$resolved_app_env_gid"; then
    :
  else
    echo "WARNING: could not stamp SENTRY_RELEASE into $APP_ENV_FILE; continuing." >&2
    echo "         Sentry will attribute this release to the previous tag." >&2
  fi
fi

# ── 起新色并等健康 ──────────────────────────────────────────────
echo "==> Starting $standby"
if ! compose up -d --no-build --no-deps "$standby"; then
  echo "Failed to create $standby" >&2
  compose logs --tail 200 "$standby" >&2 || true
  compose rm -sf "$standby" || true
  handle_post_migration_failure
  exit 1
fi
if ! wait_healthy "$standby" 300; then
  compose logs --tail 200 "$standby" >&2 || true
  if irreversible_boundary_crossed; then
    enter_irreversible_maintenance
  else
    compose rm -sf "$standby" || true
    restore_live || true
  fi
  exit 1
fi

# ── 切换代理 → 烟测 → 通过后才停/删旧色 ──────────────────────
echo "==> $standby healthy; switching Caddy upstream"
if ! switch_proxy "$standby"; then
  echo "==> Caddy switch failed; leaving previous version $live live" >&2
  if irreversible_boundary_crossed; then
    enter_irreversible_maintenance
    exit 1
  fi
  if [ -n "$live" ]; then
    if ! ensure_live; then
      echo "warning: leaving both colors running for manual recovery" >&2
      exit 1
    fi
    compose rm -sf "$standby" || true
  else
    echo "warning: no previous version exists; leaving standby running" >&2
  fi
  exit 1
fi
if ! persist_active_color "$standby"; then
  echo "==> Could not persist active color; rolling Caddy back" >&2
  if irreversible_boundary_crossed; then
    enter_irreversible_maintenance
    exit 1
  fi
  if [ -n "$live" ]; then
    if ! ensure_live || ! switch_proxy "$live"; then
      echo "warning: Caddy rollback failed; leaving both colors running" >&2
      exit 1
    fi
    compose rm -sf "$standby" || true
  else
    echo "warning: no previous version exists; leaving standby running" >&2
  fi
  exit 1
fi

if smoke; then
  # Persist the no-rollback decision before retiring the old color. If the host
  # dies after this point, the next release keeps the validated 0640 env file.
  commit_app_env_transaction
  if [ -n "$live" ]; then
    if [ -n "$(running "$live")" ]; then
      echo "==> Public smoke passed; stopping $live"
      compose stop "$live"
    fi
    compose rm -f "$live"
  fi
  echo "==> Release $RELEASE_TAG deployed: $standby is live on $CIRCLE_BE_IMAGE"
else
  echo "==> Smoke test failed; rolling back to previous version" >&2
  compose logs --tail 100 "$standby" >&2 || true
  if irreversible_boundary_crossed; then
    enter_irreversible_maintenance
    exit 1
  fi
  if [ -n "$live" ]; then
    if ! ensure_live; then
      echo "warning: previous version is unavailable; leaving standby in service" >&2
      exit 1
    fi
    if ! switch_proxy "$live"; then
      echo "warning: Caddy rollback failed; leaving both colors running for manual recovery" >&2
      exit 1
    fi
    persist_active_color "$live"
    compose rm -sf "$standby" || true
    echo "==> Rolled back: $live restored" >&2
  else
    echo "warning: no previous version exists; leaving the healthy standby running" >&2
  fi
  exit 1
fi
