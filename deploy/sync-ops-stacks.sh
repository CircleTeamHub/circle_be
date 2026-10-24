#!/usr/bin/env bash
# 发版成功后，把**已经在跑**的可选运维栈同步到这次发布的配置：
#   - 备份 overlay（docker-compose.backup.yml 的 backup / backup-metrics）
#   - 监控栈（monitoring/docker-compose*.yml：Prometheus、Alertmanager、…）
#   - 日志 overlay（monitoring/docker-compose.logs.yml：Loki、Alloy）
#
# 告警规则、抑制、Loki 规则与 Alloy 采集配置都随代码一起改。发版脚本此前完全不
# 碰这些栈，合进 main 的告警于是永远不会在服务器上生效，除非有人记得手动重建。
#
# 规则：
#   - 只同步正在跑的栈，且只动其中正在跑的服务；没启用的绝不在这里第一次拉起 ——
#     那需要按文档先配好凭证和目标（docs/backups.md、monitoring/README.md、
#     monitoring/logs.md）。
#   - compose 项目名、文件、env 文件全部取自运行中容器的 compose 标签，与运维
#     当初启动它时完全一致；从别的目录启动的栈不碰，只提示。
#   - 单文件挂载的服务（Prometheus 规则、Loki/Alloy/blackbox 配置…）强制重建：
#     发布替换文件后容器仍钉着旧 inode，reload 读到的还是旧内容。
#   - 绝不碰 postgres：备份 overlay 也改写了它，但重建它就是一次数据库重启。
#     同理不强制重建 backup：两者共用 pgbackrest.conf，只重建一边会让配置分叉；
#     改 pgbackrest.conf 要按 docs/backups.md 择时一起重启。
#   - 宁可不同步也不拉坏，以下情况只提示并跳过，运行中的容器保持原样：旧 launcher
#     同步的树、手动回滚（历史树 + 当前工具）、挂载源或 exporter 连接串缺失、日志
#     overlay 要的卷还没建、剩余时间不够跑完一步。
#   - 尽力而为：任何失败只告警，退出码恒为 0。发版此时已经完成。
#
# 关闭：自动发版的环境变量是固定的（release-force-command.sh 用 env -i），所以用
# 文件开关 `touch .release/skip-ops-sync`；手动运行时 RELEASE_SYNC_OPS_STACKS=0 也行。
# OPS_SYNC_TIMEOUT_SECONDS 是整个同步的时间预算（默认 300 秒），发版 job 自身有
# 30 分钟上限；会改动容器的一步至少要剩 OPS_SYNC_MIN_STEP_SECONDS（默认 60 秒）
# 才开始，免得 timeout 在重建到一半时杀掉 compose。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 0
repo_logical="$(pwd)"
repo_physical="$(pwd -P)"
state_dir="${RELEASE_STATE_DIR:-$repo_logical/.release}"

# 提示走原始 stderr 的副本：docker 调用的 2>/dev/null 不能把它们一起吞掉。
exec 3>&2
warn() { echo "WARNING: $*" >&3; }

if [ "${RELEASE_SYNC_OPS_STACKS:-1}" = "0" ] || [ -e "$state_dir/skip-ops-sync" ]; then
  echo "==> Ops stack sync is switched off (RELEASE_SYNC_OPS_STACKS=0 or $state_dir/skip-ops-sync); leaving them as they are"
  exit 0
fi

# 手动回滚：历史发布的树上叠了当前的发版工具（deploy/overlay-trusted-release-tooling.sh
# 留下这个标记）。监控栈的 compose 文件是旧的、规则是新的，照它同步会把之后新增
# 的服务当孤儿删掉。下一次正常发版会把标记连同历史树一起换掉。
if [ -e "$repo_logical/.release-tooling-overlay" ]; then
  warn "this tree is a historical release with the current release tooling overlaid (manual rollback);" \
    "the ops stacks keep their configuration until the next regular release"
  exit 0
fi

# 旧版 launcher 的 rsync --delete 会删掉本机运维配置（.env.backup、监控栈的
# .env/.env.exporters、Alertmanager webhook、抓取令牌、探测目标），并把整棵树收成
# go-rwx。照那样的树重建，exporter 会丢连接串、以非 root 运行的容器读不了挂载。
# 新 launcher 会设这个标记；手动运行本脚本时没有 RELEASE_LAUNCHER_ACTIVE，不受限。
if [ "${RELEASE_LAUNCHER_ACTIVE:-0}" = "1" ] && [ "${RELEASE_LAUNCHER_KEEPS_HOST_CONFIG:-0}" != "1" ]; then
  warn "the trusted release launcher on this host predates host-config preservation; not syncing the ops stacks." \
    "Reinstall .release/release-launcher.sh (docs/release-hardening-runbook.md), restore any deleted host files, then run deploy/sync-ops-stacks.sh by hand"
  exit 0
fi

budget="${OPS_SYNC_TIMEOUT_SECONDS:-300}"
[[ "$budget" =~ ^[0-9]+$ ]] || budget=300
min_step="${OPS_SYNC_MIN_STEP_SECONDS:-60}"
[[ "$min_step" =~ ^[0-9]+$ ]] || min_step=60
deadline=$(( $(date +%s) + budget ))
have_timeout=0
command -v timeout >/dev/null 2>&1 && have_timeout=1

with_timeout() {
  local seconds="$1"
  shift
  if [ "$have_timeout" = 1 ]; then
    timeout -k 10 "$seconds" "$@"
  else
    "$@"
  fi
}

# 只读或可安全中断的调用（ps、inspect、config、build）：用剩余预算兜底，卡住的
# daemon 或慢构建不能把发版 job 拖到超时。
bounded() {
  local left=$(( deadline - $(date +%s) ))
  if (( left < 5 )); then
    warn "the ${budget}s ops sync budget is used up; skipped: ${*:1:3} … (OPS_SYNC_TIMEOUT_SECONDS)"
    return 124
  fi
  with_timeout "$left" "$@"
}

# 构建最多用掉预算的三分之一：基础镜像被清掉、registry 又慢时，备份构建不能把
# 后面监控栈（告警规则）的同步饿死。构建被打断是安全的，下次发版接着拉。
build_bounded() {
  local left=$(( deadline - $(date +%s) )) cap=$(( budget / 3 ))
  (( cap < left )) && left="$cap"
  if (( left < 5 )); then
    warn "the ${budget}s ops sync budget is used up; skipped: ${*:1:3} … (OPS_SYNC_TIMEOUT_SECONDS)"
    return 124
  fi
  with_timeout "$left" "$@"
}

# 会停掉、重建容器的调用：剩余时间不够就干脆不开始（返回 NOT_STARTED，什么都没
# 碰）。中途被 timeout 杀掉的 compose 会留下停掉的旧容器、没有新容器，而 restart
# 策略救不回 API 停掉的容器。
NOT_STARTED=75
mutate() {
  local left=$(( deadline - $(date +%s) ))
  if (( left < min_step )); then
    warn "only ${left}s of the ${budget}s ops sync budget is left (a step needs ${min_step}s); not starting: ${*:1:3} …"
    return "$NOT_STARTED"
  fi
  with_timeout "$left" "$@"
}

LABEL_FORMAT='{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.environment_file"}}'

# 运行中、属于某个 compose 服务的全部容器。
running_containers() {
  bounded docker ps -q --filter "label=com.docker.compose.service=$1" --filter status=running 2>/dev/null || true
}

# 某个项目里正在跑的服务名，一行一个。
running_services() {
  bounded docker ps --filter "label=com.docker.compose.project=$1" --filter status=running \
    --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null | sort -u
}

# 往数组里追加逗号分隔的路径，保持首次出现的顺序、去重（compose 文件顺序决定覆盖关系）。
#   append_unique <数组名> <逗号分隔列表>
append_unique() {
  local -n target="$1"
  local item existing seen
  local -a items=()
  [ -n "$2" ] || return 0
  IFS=, read -ra items <<< "$2"
  for item in "${items[@]}"; do
    seen=0
    for existing in "${target[@]}"; do
      [ "$existing" = "$item" ] && { seen=1; break; }
    done
    [ "$seen" = 1 ] || target+=("$item")
  done
}

contains() {
  local needle="$1" item
  shift
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

# 用容器的 compose 标签拼出与当初启动时一致的参数，存进 COMPOSE_ARGS。
#   load_compose_args <cid> <期望的项目目录（相对仓库根）>
# 返回 0 = 可同步；1 = 标签读不出；2 = 这个栈是从别的目录启动的。
COMPOSE_ARGS=()
STACK_PROJECT=""
STACK_FILES=()
STACK_ENVS=()
load_compose_args() {
  local cid="$1" subdir="$2" labels project files dir envs
  labels="$(bounded docker inspect --format "$LABEL_FORMAT" "$cid" 2>/dev/null)" || return 1
  IFS='|' read -r project files dir envs <<< "$labels"
  [ -n "$project" ] && [ -n "$files" ] || return 1
  if [ "$dir" != "$repo_logical$subdir" ] && [ "$dir" != "$repo_physical$subdir" ]; then
    LAST_FOREIGN_DIR="$dir"
    return 2
  fi
  STACK_PROJECT="$project"
  STACK_FILES=()
  STACK_ENVS=()
  append_unique STACK_FILES "$files"
  append_unique STACK_ENVS "$envs"
  build_compose_args
  return 0
}

build_compose_args() {
  local file
  COMPOSE_ARGS=(-p "$STACK_PROJECT")
  for file in "${STACK_ENVS[@]}"; do COMPOSE_ARGS+=(--env-file "$file"); done
  for file in "${STACK_FILES[@]}"; do COMPOSE_ARGS+=(-f "$file"); done
}

# 找到从这棵树启动的那个栈；找到返回 0。
#   find_stack <服务名> <项目目录（相对仓库根）> <栈的名字（只用于提示）>
LAST_FOREIGN_DIR=""
find_stack() {
  local service="$1" subdir="$2" label="$3" cid status
  LAST_FOREIGN_DIR=""
  for cid in $(running_containers "$service"); do
    load_compose_args "$cid" "$subdir"
    status=$?
    [ "$status" -eq 0 ] && return 0
  done
  if [ -n "$LAST_FOREIGN_DIR" ]; then
    warn "the $label runs from $LAST_FOREIGN_DIR, not from this release tree ($repo_logical$subdir); not syncing it"
  fi
  return 1
}

compose_uses() {
  case " ${COMPOSE_ARGS[*]} " in *"/$1 "*) return 0 ;; esac
  return 1
}

# 按这次发布的 compose 文件解析出：定义了哪些服务、各自的 bind mount 源、以及
# caddy_logs 卷的真实名字。读的是**新**定义，所以这次发布新增的挂载也会被检查。
#   service|<服务>   bind|<服务>|<源>   volume|caddy_logs|<名字>
CONFIG_LINES=()
load_config() {
  local rendered
  rendered="$(bounded docker compose "${COMPOSE_ARGS[@]}" config 2>/dev/null)" || return 1
  mapfile -t CONFIG_LINES < <(printf '%s\n' "$rendered" | awk '
    /^[^ ]/ { top = $0; svc = ""; bind = 0; vol = ""; next }
    top == "services:" && /^  [^ ]/ { svc = $1; sub(/:$/, "", svc); print "service|" svc; bind = 0; next }
    top == "services:" && /^ +- type: / { bind = ($0 ~ /- type: bind$/); next }
    top == "services:" && bind && /^ +source: / {
      src = $0; sub(/^ +source: /, "", src); gsub(/"/, "", src); print "bind|" svc "|" src; bind = 0; next
    }
    top == "volumes:" && /^  [^ ]/ { vol = $1; sub(/:$/, "", vol); next }
    top == "volumes:" && vol == "caddy_logs" && /^    name: / {
      name = $0; sub(/^    name: /, "", name); gsub(/"/, "", name); print "volume|caddy_logs|" name; next
    }
  ')
  return 0
}

config_field() {
  local kind="$1" key="$2" line
  for line in "${CONFIG_LINES[@]}"; do
    case "$line" in "$kind|$key|"*) printf '%s\n' "${line#"$kind|$key|"}" ;; esac
  done
}

defined_services() {
  local line
  for line in "${CONFIG_LINES[@]}"; do
    case "$line" in service\|*) printf '%s\n' "${line#service|}" ;; esac
  done
}

# 这些服务的 bind mount 源都还在；缺一个就返回 1 并提示。单文件挂载的源不存在
# 时，Docker 会以 root 建出一个同名**目录**，容器随后读配置失败。
#   mounts_present <栈的名字> <服务>...
mounts_present() {
  local label="$1" service source
  local -a missing=()
  shift
  for service in "$@"; do
    while IFS= read -r source; do
      [ -n "$source" ] && [ ! -e "$source" ] && missing+=("$source")
    done < <(config_field bind "$service")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    warn "the $label bind-mounts files that are gone (${missing[*]}); not syncing it." \
      "Restore them (see that directory's *.example), then run deploy/sync-ops-stacks.sh by hand"
    return 1
  fi
  return 0
}

# 挂了这棵树里单个文件的服务。
single_file_mount_services() {
  local service source
  for service in "$@"; do
    while IFS= read -r source; do
      case "$source" in "$repo_logical"/* | "$repo_physical"/*) ;; *) continue ;; esac
      if [ -f "$source" ]; then
        printf '%s\n' "$service"
        break
      fi
    done < <(config_field bind "$service")
  done
}

# 重建失败（含被 timeout 打断）之后，把没在跑的服务按新配置再拉起来；拉不起来就
# 大声说出来 —— 这时告警链路可能已经断了。
#   ensure_running <服务>...
ensure_running() {
  local service ids
  local -a down=()
  for service in "$@"; do
    # 不受总预算限制：此刻预算多半已经用完，而这正是最该查的时候。查询本身失败
    # （daemon 卡住）就不动手 —— 看不到不等于停了。
    if ! ids="$(with_timeout 30 docker ps -q --filter "label=com.docker.compose.project=$STACK_PROJECT" \
      --filter "label=com.docker.compose.service=$service" --filter status=running 2>/dev/null)"; then
      warn "could not check whether $service of $STACK_PROJECT is still running; check docker compose ps by hand"
      return 0
    fi
    [ -n "$ids" ] || down+=("$service")
  done
  [ "${#down[@]}" -gt 0 ] || return 0
  warn "${down[*]} stopped during the failed sync; starting them again"
  with_timeout 120 docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps "${down[@]}" ||
    warn "${down[*]} of $STACK_PROJECT are DOWN — alerting may be broken; run docker compose ps and bring them up by hand"
}

sync_backup() {
  local -a targets=(backup backup-metrics)
  find_stack backup "" "backup overlay" || return 0
  if ! compose_uses docker-compose.backup.yml; then
    warn "the backup container was not started with docker-compose.backup.yml; not syncing it"
    return 0
  fi
  load_config || { warn "docker compose could not load the backup overlay; not syncing it"; return 0; }
  mounts_present "backup overlay" "${targets[@]}" || return 0
  echo "==> Syncing the backup overlay to this release (backup, backup-metrics)"
  # 先单独构建：构建可以安全中断，重建容器不行。
  if ! build_bounded docker compose "${COMPOSE_ARGS[@]}" build backup backup-metrics; then
    warn "building the backup overlay failed or ran past $(( budget / 3 ))s; backup alerts keep the previous configuration"
    return 0
  fi
  mutate docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps backup backup-metrics
  case $? in
    0) ;;
    "$NOT_STARTED") warn "the backup overlay keeps the previous configuration" ;;
    *)
      warn "syncing the backup overlay failed; backup alerts keep the previous configuration"
      ensure_running backup backup-metrics
      ;;
  esac
}

# 日志 overlay 读核心栈的 caddy_logs 卷（external）。它要等运维按 monitoring/logs.md
# 重建一次 caddy 才存在；不存在时 compose 会整栈失败，所以提前说清楚怎么办。
caddy_logs_volume_ready() {
  local name
  name="$(config_field volume caddy_logs | head -1)"
  # 解析不出名字就交给 compose 自己报错。
  [ -n "$name" ] || return 0
  bounded docker volume inspect "$name" >/dev/null 2>&1 && return 0
  warn "the logs overlay needs the volume $name, which does not exist yet; not syncing the monitoring stack." \
    "Recreate caddy once from the core stack (monitoring/logs.md), then run deploy/sync-ops-stacks.sh by hand"
  return 1
}

# monitoring/docker-compose.prod.yml 里 required: false 的 env_file：文件缺了 compose
# 不报错，而是把 exporter 以空连接串重建 —— pg_up/redis_up 掉零，比不同步更糟。
#   <服务…>|<文件（相对仓库根）>
OPTIONAL_ENV_FILES=('postgres-exporter redis-exporter|monitoring/.env.exporters')
optional_env_files_present() {
  local entry services file service
  for entry in "${OPTIONAL_ENV_FILES[@]}"; do
    services="${entry%%|*}"
    file="${entry#*|}"
    for service in $services; do
      contains "$service" "$@" || continue
      if [ ! -s "$repo_logical/$file" ]; then
        warn "$service runs with $file, which is missing or empty; not syncing the monitoring stack." \
          "Recreate it (monitoring/sync-exporter-env.sh), then run deploy/sync-ops-stacks.sh by hand"
        return 1
      fi
    done
  done
  return 0
}

sync_monitoring() {
  local -a cids=() targets=() recreate=() up_args=(up -d --no-deps)
  local project files dir envs consistent=1 first="" service inspected=0
  find_stack prometheus /monitoring "monitoring stack" || return 0

  # --remove-orphans 删掉项目里「这些文件没定义」的服务。若有服务是带别的 overlay
  # 起来的，只用 prometheus 的文件集会把它们当孤儿删掉、或把它们的覆盖去掉；所以取
  # 项目里全部容器文件集的并集，且只在文件集一致时才清孤儿。
  # 清孤儿是破坏性的：只有把项目里每个容器都数清楚、且都从这棵树按同一组文件
  # 起来时才做。枚举偶发失败返回空，宁可这次不清。
  read -ra cids <<< "$(bounded docker ps -aq --filter "label=com.docker.compose.project=$STACK_PROJECT" 2>/dev/null | tr '\n' ' ')"
  [ "${#cids[@]}" -gt 0 ] || consistent=0
  if [ "${#cids[@]}" -gt 0 ]; then
    while IFS='|' read -r project files dir envs; do
      [ -n "$files" ] || continue
      if [ "$dir" != "$repo_logical/monitoring" ] && [ "$dir" != "$repo_physical/monitoring" ]; then
        consistent=0
        continue
      fi
      inspected=$(( inspected + 1 ))
      if [ -z "$first" ]; then
        first="$files|$envs"
      elif [ "$files|$envs" != "$first" ]; then
        consistent=0
      fi
      append_unique STACK_FILES "$files"
      append_unique STACK_ENVS "$envs"
    done < <(bounded docker inspect --format "$LABEL_FORMAT" "${cids[@]}" 2>/dev/null)
    build_compose_args
  fi
  [ "$inspected" -eq "${#cids[@]}" ] || consistent=0
  if [ "$consistent" = 1 ]; then
    up_args+=(--remove-orphans)
  else
    warn "could not confirm that every container of the monitoring stack was started from this tree with the same compose files; syncing with their union and not removing orphans"
  fi

  load_config || { warn "docker compose could not load the monitoring stack; not syncing it"; return 0; }
  # 只动正在跑、且这次发布仍然定义的服务：运维刻意停掉的不拉起，新增的服务要先按
  # 文档配好再手动起；不再定义的由 --remove-orphans 清掉。
  mapfile -t targets < <(comm -12 <(running_services "$STACK_PROJECT") <(defined_services | sort -u))
  if [ "${#targets[@]}" -eq 0 ]; then
    warn "none of the running monitoring services is defined by this release; not syncing it"
    return 0
  fi
  mounts_present "monitoring stack" "${targets[@]}" || return 0
  optional_env_files_present "${targets[@]}" || return 0
  if compose_uses docker-compose.logs.yml; then
    caddy_logs_volume_ready || return 0
  fi

  # Alertmanager 挂的是目录，能看到新文件，但进程不会自己重读配置。
  contains alertmanager "${targets[@]}" && recreate+=(alertmanager)
  while IFS= read -r service; do
    contains "$service" "${recreate[@]}" || recreate+=("$service")
  done < <(single_file_mount_services "${targets[@]}")

  echo "==> Syncing the monitoring stack ($STACK_PROJECT) to this release: ${targets[*]}"
  mutate docker compose "${COMPOSE_ARGS[@]}" "${up_args[@]}" "${targets[@]}"
  case $? in
    0) ;;
    "$NOT_STARTED")
      warn "the monitoring stack keeps the previous rules"
      return 0
      ;;
    *)
      warn "bringing the monitoring stack up to date failed; alerts keep the previous rules"
      ensure_running "${targets[@]}"
      return 0
      ;;
  esac
  [ "${#recreate[@]}" -gt 0 ] || return 0
  mutate docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps --force-recreate "${recreate[@]}"
  case $? in
    0) ;;
    "$NOT_STARTED") warn "${recreate[*]} keep serving the previous rules and configuration" ;;
    *)
      warn "recreating ${recreate[*]} failed; the ones still running serve the previous rules and configuration"
      ensure_running "${recreate[@]}"
      ;;
  esac
}

# 备份在前：Prometheus 的 backup job 按名字发现 backup-metrics。
sync_backup
sync_monitoring
exit 0
