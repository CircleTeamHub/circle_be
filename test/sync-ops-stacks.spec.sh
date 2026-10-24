#!/usr/bin/env bash
# deploy/sync-ops-stacks.sh：发版成功后，把已经在跑的可选运维栈（备份 overlay、
# 监控栈、日志 overlay）同步到这次发布的配置。告警规则、抑制、Loki/Alloy 配置随
# 代码一起改；不同步的话，合进 main 的告警永远不会在服务器上生效。
#
# 用桩替换 docker，逐项验证：只动在跑的栈和服务、照原样复用它们启动时的 compose
# 文件、单文件挂载的服务强制重建、各种「同步会更糟」的情形一律跳过、任何失败都
# 不影响发版（退出码恒为 0）。脚本复制进一棵临时树里跑，挂载源都在这棵树下。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="$tmp_dir/bin"
tree="$tmp_dir/tree"
mon="$tree/monitoring"
mkdir -p "$fake_bin" "$tree/deploy/backup" "$mon/prometheus" "$mon/alertmanager" \
  "$mon/grafana/dashboards" "$mon/loki/rules"
cp "$repo_root/deploy/sync-ops-stacks.sh" "$tree/deploy/"
script="$tree/deploy/sync-ops-stacks.sh"
: > "$mon/prometheus/alerts.yml"
: > "$mon/loki/config.yml"
: > "$tree/deploy/backup/pgbackrest.conf"
printf 'DATA_SOURCE_NAME=x\n' > "$mon/.env.exporters"

# 桩的输入：
#   STUB_SERVICES="prometheus=cid-p,backup=cid-b"  哪些服务有在跑的容器
#   STUB_LABELS_<cid>      inspect 的 project|config_files|working_dir|env_files
#   STUB_PROJECT_<项目>     项目里的全部容器（空格分隔）
#   STUB_RUNNING_<项目>     项目里在跑的服务（逗号分隔）
#   STUB_DOWN              ensure_running 查询时报告为没在跑的服务（逗号分隔）
#   STUB_COMPOSE_CONFIG    `compose config` 的输出
#   STUB_VOLUMES           已存在的卷
#   STUB_COMPOSE_FAIL      compose 参数里含这段文字时失败
#   STUB_COMPOSE_SLOW      compose 参数里含这段文字时先睡 STUB_SLOW_SECONDS 秒
cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
key() { local k="${1//-/_}"; printf '%s' "${k//./_}"; }
filter() { printf '%s\n' "$2" | sed -n "s/.*label=com\.docker\.compose\.$1=\([^ ]*\).*/\1/p"; }
case "${1:-}" in
  ps)
    service="$(filter service "$*")"
    project="$(filter project "$*")"
    if [ -n "$project" ] && [ -n "$service" ]; then
      [ "${STUB_PS_FAIL_WITH_SERVICE:-0}" != 1 ] || exit 1
      case ",${STUB_DOWN:-}," in *",$service,"*) ;; *) printf 'cid-%s\n' "$service" ;; esac
    elif [ -n "$project" ] && [[ "$*" == *--format* ]]; then
      var="STUB_RUNNING_$(key "$project")"
      IFS=, read -ra names <<< "${!var:-}"
      for name in "${names[@]}"; do printf '%s\n' "$name"; done
    elif [ -n "$project" ]; then
      var="STUB_PROJECT_$(key "$project")"
      for cid in ${!var:-}; do printf '%s\n' "$cid"; done
    else
      IFS=, read -ra pairs <<< "${STUB_SERVICES:-}"
      for pair in "${pairs[@]}"; do
        [ "${pair%%=*}" = "$service" ] && printf '%s\n' "${pair#*=}"
      done
    fi
    exit 0
    ;;
  inspect)
    shift 3
    for cid in "$@"; do
      var="STUB_LABELS_$(key "$cid")"
      printf '%s\n' "${!var:-}"
    done
    ;;
  volume)
    case ",${STUB_VOLUMES:-}," in *",$3,"*) exit 0 ;; esac
    exit 1
    ;;
  compose)
    if [ "${*: -1}" = "config" ]; then
      printf '%s\n' "${STUB_COMPOSE_CONFIG:-}"
      exit 0
    fi
    if [ -n "${STUB_COMPOSE_SLOW:-}" ] && [[ "$*" == *"$STUB_COMPOSE_SLOW"* ]]; then
      sleep "${STUB_SLOW_SECONDS:-1}"
    fi
    if [ -n "${STUB_COMPOSE_FAIL:-}" ] && [[ "$*" == *"$STUB_COMPOSE_FAIL"* ]]; then
      exit 1
    fi
    ;;
  *) exit 64 ;;
esac
SH
chmod +x "$fake_bin/docker"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

run_sync() {
  local name="$1"; shift
  local dir="$tmp_dir/$name"
  mkdir -p "$dir"
  : > "$dir/docker.log"
  local rc=0
  env PATH="$fake_bin:$PATH" DOCKER_LOG="$dir/docker.log" RELEASE_STATE_DIR="$dir/state" "$@" \
    bash "$script" >"$dir/out" 2>"$dir/err" || rc=$?
  printf '%s' "$rc"
}
log_of() { printf '%s' "$tmp_dir/$1/docker.log"; }
expect_line() {
  grep -qxF -- "$2" "$(log_of "$1")" || { cat "$(log_of "$1")" >&2; fail "$1: $3"; }
}
expect_no_up() {
  if grep -qE '^compose .* up( |$)' "$(log_of "$1")"; then cat "$(log_of "$1")" >&2; fail "$1: $2"; fi
}
expect_err() {
  grep -q -- "$2" "$tmp_dir/$1/err" || { cat "$tmp_dir/$1/err" >&2; fail "$1: $3"; }
}

mon_files="$mon/docker-compose.yml,$mon/docker-compose.prod.yml"
logs_files="$mon_files,$mon/docker-compose.logs.yml"
mon_args="-p monitoring --env-file $mon/.env -f $mon/docker-compose.yml -f $mon/docker-compose.prod.yml"
mon_labels="monitoring|$mon_files|$mon|$mon/.env"

# 一份 `docker compose config` 的最小渲染：服务、bind mount、卷。
monitoring_config() {
  cat <<YAML
name: monitoring
services:
  alertmanager:
    volumes:
      - type: bind
        source: $mon/alertmanager
        target: /etc/alertmanager
  grafana:
    volumes:
      - type: bind
        source: $mon/grafana/dashboards
        target: /var/lib/grafana/dashboards
      - type: volume
        source: grafana_data
        target: /var/lib/grafana
  loki:
    volumes:
      - type: bind
        source: $mon/loki/config.yml
        target: /etc/loki/config.yml
  node-exporter:
    volumes:
      - type: bind
        source: /
        target: /host
  postgres-exporter:
    image: x
  prometheus:
    volumes:
      - type: bind
        source: $mon/prometheus/alerts.yml
        target: /etc/prometheus/alerts.yml
${1:-}
volumes:
  caddy_logs:
    name: circle-be_caddy_logs
    external: true
  grafana_data:
    name: monitoring_grafana_data
YAML
}
CONFIG="$(monitoring_config)"

# ── 什么都没在跑：一个 compose 都不调 ───────────────────────────────────
rc="$(run_sync none)"
[ "$rc" = 0 ] || fail "nothing-running exited $rc"
if grep -q '^compose ' "$(log_of none)"; then fail 'compose called with no stack running'; fi

# ── 监控栈：只动在跑且仍有定义的服务；单文件挂载的和 Alertmanager 强制重建 ─────
#    loki 有定义但没在跑 → 不拉起；uptime-kuma 在跑但不再定义 → 交给 --remove-orphans。
rc="$(run_sync monitoring STUB_SERVICES=prometheus=cid-p STUB_PROJECT_monitoring=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus,alertmanager,grafana,node-exporter,uptime-kuma \
  STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "monitoring sync exited $rc"
expect_line monitoring "compose $mon_args up -d --no-deps --remove-orphans alertmanager grafana node-exporter prometheus" \
  'monitoring stack not brought up with its own files, its running services only'
expect_line monitoring "compose $mon_args up -d --no-deps --force-recreate alertmanager prometheus" \
  'single-file mounts and alertmanager not force-recreated (or directory mounts recreated needlessly)'

# ── 项目里的容器枚举不出来（daemon 偶发失败）：不清孤儿 ─────────────────────
rc="$(run_sync noenum STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "no-enumeration sync exited $rc"
expect_line noenum "compose $mon_args up -d --no-deps prometheus" 'removed orphans without knowing every container'

# ── 项目里有容器是从别的目录起来的：不清孤儿，也不并它的文件 ────────────────
rc="$(run_sync foreigncontainer STUB_SERVICES=prometheus=cid-p STUB_PROJECT_monitoring="cid-p cid-o" \
  STUB_LABELS_cid_p="$mon_labels" STUB_LABELS_cid_o="monitoring|/srv/old/monitoring/x.yml|/srv/old/monitoring|" \
  STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "foreign-container sync exited $rc"
expect_line foreigncontainer "compose $mon_args up -d --no-deps prometheus" 'unioned or orphan-removed with a container from another tree'

# ── 带日志 overlay、卷已存在：挂单文件的 loki 也重建 ─────────────────────────
rc="$(run_sync logs STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="monitoring|$logs_files|$mon|" \
  STUB_RUNNING_monitoring=prometheus,alertmanager,loki STUB_VOLUMES=circle-be_caddy_logs \
  STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "logs sync exited $rc"
expect_line logs "volume inspect circle-be_caddy_logs" 'external volume not checked'
expect_line logs "compose -p monitoring -f $mon/docker-compose.yml -f $mon/docker-compose.prod.yml -f $mon/docker-compose.logs.yml up -d --no-deps --force-recreate alertmanager loki prometheus" \
  'loki not recreated with the logs overlay'

# ── 日志 overlay 但 caddy_logs 卷还没建：整栈不动，提示先重建 caddy ─────────────
rc="$(run_sync novolume STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="monitoring|$logs_files|$mon|" \
  STUB_RUNNING_monitoring=prometheus,loki STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "missing-volume sync exited $rc"
expect_no_up novolume 'brought the logs overlay up without its external volume'
expect_err novolume 'Recreate caddy once' 'no hint to recreate caddy'

# ── 从别的目录启动的监控栈：不碰，只提示 ─────────────────────────────────
rc="$(run_sync elsewhere STUB_SERVICES=prometheus=cid-p \
  STUB_LABELS_cid_p="monitoring|/srv/old/monitoring/docker-compose.yml|/srv/old/monitoring|")"
[ "$rc" = 0 ] || fail "foreign-tree sync exited $rc"
if grep -q '^compose ' "$(log_of elsewhere)"; then fail 'touched a stack started from another tree'; fi
expect_err elsewhere 'not from this release tree' 'no hint about the foreign tree'

# ── 挂载源缺失：不重建（Docker 会把缺的单文件建成目录）──────────────────────
blackbox_config="$(monitoring_config "  blackbox-exporter:
    volumes:
      - type: bind
        source: $mon/blackbox/blackbox.yml
        target: /etc/blackbox/blackbox.yml")"
rc="$(run_sync nomount STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus,alertmanager,blackbox-exporter STUB_COMPOSE_CONFIG="$blackbox_config")"
[ "$rc" = 0 ] || fail "missing-mount sync exited $rc"
expect_no_up nomount 'recreated a stack whose bind-mount source is gone'
expect_err nomount 'blackbox/blackbox.yml' 'missing mount not named'

# ── exporter 的连接串文件没了：不重建（required: false 会让它以空连接串起来）────
mv "$mon/.env.exporters" "$mon/.env.exporters.bak"
rc="$(run_sync noexporterenv STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus,postgres-exporter STUB_COMPOSE_CONFIG="$CONFIG")"
mv "$mon/.env.exporters.bak" "$mon/.env.exporters"
[ "$rc" = 0 ] || fail "missing-exporter-env sync exited $rc"
expect_no_up noexporterenv 'recreated postgres-exporter without its connection string'
expect_err noexporterenv 'monitoring/.env.exporters' 'missing exporter env file not named'

# ── 项目里有容器带了别的 overlay：取并集、不清孤儿 ──────────────────────────
extra="$mon/docker-compose.extra.yml"
rc="$(run_sync mixed STUB_SERVICES=prometheus=cid-p STUB_PROJECT_monitoring="cid-p cid-x" \
  STUB_LABELS_cid_p="$mon_labels" STUB_LABELS_cid_x="monitoring|$mon_files,$extra|$mon|$mon/.env" \
  STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "mixed-files sync exited $rc"
expect_line mixed "compose $mon_args -f $extra up -d --no-deps prometheus" \
  'mixed file sets not unioned, or orphans removed anyway'

# ── 备份 overlay：先构建、再只起 backup 和 backup-metrics，绝不碰 postgres ─────
backup_labels="circle-be|$tree/docker-compose.prod.yml,$tree/docker-compose.backup.yml|$tree|"
backup_config="name: circle-be
services:
  backup:
    volumes:
      - type: bind
        source: $tree/deploy/backup/pgbackrest.conf
        target: /etc/pgbackrest/pgbackrest.conf
  backup-metrics:
    image: x
  postgres:
    image: x"
backup_args="-p circle-be -f $tree/docker-compose.prod.yml -f $tree/docker-compose.backup.yml"
rc="$(run_sync backup STUB_SERVICES=backup=cid-b STUB_LABELS_cid_b="$backup_labels" STUB_COMPOSE_CONFIG="$backup_config")"
[ "$rc" = 0 ] || fail "backup sync exited $rc"
expect_line backup "compose $backup_args build backup backup-metrics" 'backup image not built first'
expect_line backup "compose $backup_args up -d --no-deps backup backup-metrics" 'backup overlay not synced'
if grep -E '^compose .* (up|build)' "$(log_of backup)" | grep -q postgres; then fail 'postgres must never be recreated by the sync'; fi
if grep -q -- '--force-recreate' "$(log_of backup)"; then fail 'backup force-recreated (pgbackrest.conf is shared with postgres)'; fi

mv "$tree/deploy/backup/pgbackrest.conf" "$tree/deploy/backup/pgbackrest.conf.bak"
rc="$(run_sync backupnomount STUB_SERVICES=backup=cid-b STUB_LABELS_cid_b="$backup_labels" STUB_COMPOSE_CONFIG="$backup_config")"
mv "$tree/deploy/backup/pgbackrest.conf.bak" "$tree/deploy/backup/pgbackrest.conf"
[ "$rc" = 0 ] || fail "backup missing-mount sync exited $rc"
if grep -qE '^compose .* (up|build)' "$(log_of backupnomount)"; then fail 'synced the backup overlay with pgbackrest.conf gone'; fi
expect_err backupnomount 'pgbackrest.conf' 'missing backup mount not named'

# ── 构建之后剩的时间不够一步：不再开始重建容器（timeout 不能在重建中途杀掉 compose）
#    预算 15s，构建最多 5s、这里用了 3s；剩下约 12s，不到一步要的 14s。
rc="$(run_sync slowbuild OPS_SYNC_TIMEOUT_SECONDS=15 OPS_SYNC_MIN_STEP_SECONDS=14 \
  STUB_COMPOSE_SLOW=' build ' STUB_SLOW_SECONDS=3 \
  STUB_SERVICES=backup=cid-b STUB_LABELS_cid_b="$backup_labels" STUB_COMPOSE_CONFIG="$backup_config")"
[ "$rc" = 0 ] || fail "slow-build sync exited $rc"
expect_line slowbuild "compose $backup_args build backup backup-metrics" 'build not attempted'
expect_no_up slowbuild 'started a container recreate without enough budget left'
expect_err slowbuild 'not starting' 'no hint about the remaining budget'
if grep -q 'starting them again' "$tmp_dir/slowbuild/err"; then fail 'slowbuild: tried to heal although nothing was touched'; fi

# ── 查不了容器状态（daemon 卡住）时不「修复」：看不到≠停了 ──────────────────────
rc="$(run_sync healunknown STUB_COMPOSE_FAIL='--force-recreate' STUB_PS_FAIL_WITH_SERVICE=1 \
  STUB_PROJECT_monitoring=cid-p STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "heal-unknown sync exited $rc"
if grep -qxF "compose $mon_args up -d --no-deps prometheus" "$(log_of healunknown)"; then fail 'healed on an unknown container state'; fi
expect_err healunknown 'could not check' 'no warning about the unknown state'

# ── 备份构建卡住：最多用掉三分之一预算，监控栈照样同步 ──────────────────────
if command -v timeout >/dev/null 2>&1; then
  rc="$(run_sync buildcap OPS_SYNC_TIMEOUT_SECONDS=12 OPS_SYNC_MIN_STEP_SECONDS=3 \
    STUB_COMPOSE_SLOW=' build ' STUB_SLOW_SECONDS=30 \
    STUB_SERVICES=backup=cid-b,prometheus=cid-p STUB_LABELS_cid_b="$backup_labels" STUB_LABELS_cid_p="$mon_labels" \
    STUB_PROJECT_monitoring=cid-p STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$backup_config
$(monitoring_config | sed -n '/^  alertmanager:/,$p')")"
  [ "$rc" = 0 ] || fail "build-cap sync exited $rc"
  expect_line buildcap "compose $mon_args up -d --no-deps --remove-orphans prometheus" \
    'a hung backup build starved the monitoring sync'
  if grep -q "compose $backup_args up " "$(log_of buildcap)"; then fail 'recreated backup after its build was cut off'; fi
else
  echo 'SKIP build cap: no timeout(1) on this host'
fi

# ── 重建失败、有服务停在半路：按新配置再拉起来 ────────────────────────────
rc="$(run_sync heal STUB_COMPOSE_FAIL='--force-recreate' STUB_DOWN=prometheus \
  STUB_PROJECT_monitoring=cid-p STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus,alertmanager STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "failed-recreate sync exited $rc"
expect_line heal "compose $mon_args up -d --no-deps prometheus" 'stopped prometheus not brought back'
expect_err heal 'starting them again' 'no warning about the stopped service'

# ── compose 本身失败：只告警，退出码 0 ───────────────────────────────────
rc="$(run_sync composefail STUB_COMPOSE_FAIL=' up ' STUB_SERVICES=prometheus=cid-p \
  STUB_LABELS_cid_p="$mon_labels" STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "compose failure exited $rc"
expect_err composefail 'WARNING' 'no warning when compose failed'

# ── 旧 launcher 同步的树（没有保留本机配置的标记）：一个 docker 都不调 ─────────
rc="$(run_sync oldlauncher RELEASE_LAUNCHER_ACTIVE=1 STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels")"
[ "$rc" = 0 ] || fail "old-launcher sync exited $rc"
[ ! -s "$(log_of oldlauncher)" ] || fail 'synced a tree the old launcher stripped of host config'
expect_err oldlauncher 'release-hardening-runbook' 'no hint to reinstall the launcher'

# ── 新 launcher（带标记）照常同步 ─────────────────────────────────────────
rc="$(run_sync newlauncher RELEASE_LAUNCHER_ACTIVE=1 RELEASE_LAUNCHER_KEEPS_HOST_CONFIG=1 \
  STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels" \
  STUB_RUNNING_monitoring=prometheus STUB_COMPOSE_CONFIG="$CONFIG")"
[ "$rc" = 0 ] || fail "new-launcher sync exited $rc"
expect_line newlauncher "compose $mon_args up -d --no-deps --force-recreate prometheus" 'new launcher tree not synced'

# ── 手动回滚（历史树 + 当前工具）：不碰运维栈 ───────────────────────────────
touch "$tree/.release-tooling-overlay"
rc="$(run_sync rollback STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels")"
rm -f "$tree/.release-tooling-overlay"
[ "$rc" = 0 ] || fail "rollback sync exited $rc"
[ ! -s "$(log_of rollback)" ] || fail 'synced the ops stacks from a historical tree'
expect_err rollback 'manual rollback' 'no hint about the rollback tree'

# ── 时间预算一开始就是 0：只提示，不调 compose ─────────────────────────────
rc="$(run_sync nobudget OPS_SYNC_TIMEOUT_SECONDS=0 STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels")"
[ "$rc" = 0 ] || fail "no-budget sync exited $rc"
if grep -q '^compose ' "$(log_of nobudget)"; then fail 'ran compose past the time budget'; fi
expect_err nobudget 'budget is used up' 'no hint about the exhausted budget'

# ── 显式关掉：环境变量（手动运行）与文件开关（自动发版只能用这个）──────────────
rc="$(run_sync disabled RELEASE_SYNC_OPS_STACKS=0 STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels")"
[ "$rc" = 0 ] || fail "disabled sync exited $rc"
[ ! -s "$(log_of disabled)" ] || fail 'RELEASE_SYNC_OPS_STACKS=0 still called docker'
mkdir -p "$tmp_dir/skipfile/state"
touch "$tmp_dir/skipfile/state/skip-ops-sync"
rc="$(run_sync skipfile STUB_SERVICES=prometheus=cid-p STUB_LABELS_cid_p="$mon_labels")"
[ "$rc" = 0 ] || fail "skip-file sync exited $rc"
[ ! -s "$(log_of skipfile)" ] || fail '.release/skip-ops-sync still called docker'

printf 'sync-ops-stacks: all assertions passed\n'
