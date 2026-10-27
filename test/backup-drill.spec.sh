#!/usr/bin/env bash
# deploy/backup/drill.sh 由备份调度器每周自动跑，结果只靠它写出的 textfile 被看见。
# 这里用桩替换 pgbackrest / psql / pg_ctl / du / df / flock，逐条钉住：
# - 每条失败路径都落成 success=0 并标出停在哪一步，且不会刷新「最近一次通过」；
# - 恢复点之后删掉的行（restored > live）与零星的空临时表不算失败；
# - 磁盘不够放第二份数据时根本不开始恢复；
# - 另一轮演练还在跑时既不动它的文件，也不覆盖它的指标；
# - 被杀掉的演练留下的恢复副本由下一轮清掉，真正的 PGDATA 绝不碰、但要报出来；
# - 回放没追到最新归档的 WAL 时判失败；
# - 线上计数逐表单独提交，不让一条语句同时攥着所有表的锁；
# - 抽样的媒体对象必须在异地副本里，只有「线上还在、副本没有」才算丢。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
drill="$repo_root/deploy/backup/drill.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"

# 每个桩把调用追加进 $STUB_CALLS，断言「某一步根本没跑」靠它。
cat > "$fake_bin/pgbackrest" <<'SH'
#!/usr/bin/env bash
echo "pgbackrest $*" >> "$STUB_CALLS"
case "$*" in
  *' restore')
    [ "${STUB_RESTORE_FAIL:-0}" != "1" ] || { echo 'ERROR: [055]: unable to load info file' >&2; exit 55; }
    for arg in "$@"; do case "$arg" in --pg1-path=*) mkdir -p "${arg#--pg1-path=}" ;; esac; done
    ;;
  *) exit 64 ;;
esac
SH
cat > "$fake_bin/pg_ctl" <<'SH'
#!/usr/bin/env bash
echo "pg_ctl $*" >> "$STUB_CALLS"
# 启动出来的 postmaster 会活得比演练脚本久：它不能继承演练锁所在的 fd 9。
case "$*" in
  *' start') if { true >&9; } 2>/dev/null; then echo "pg_ctl start inherited fd 9" >> "$STUB_CALLS"; fi ;;
esac
data=''; prev=''
for arg in "$@"; do [ "$prev" = '-D' ] && data="$arg"; prev="$arg"; done
case "$*" in
  *' start') [ "${STUB_START_FAIL:-0}" != "1" ] || exit 1; touch "$data/.running" ;;
  *' status') [ -f "$data/.running" ] ;;
  *' stop') rm -f "$data/.running" ;;
esac
SH
cat > "$fake_bin/psql" <<'SH'
#!/usr/bin/env bash
host=''; sql=''; prev=''
for arg in "$@"; do
  case "$prev" in
    -h) host="$arg" ;;
    -c) sql="$arg" ;;
    -f) [ "$arg" = - ] && sql="$(cat)" ;;
  esac
  prev="$arg"
done
echo "psql PGAPPNAME=${PGAPPNAME:-}" >> "$STUB_CALLS"
case "$sql" in
  *pg_last_xact_replay_timestamp*) printf '%s\n' "${STUB_RESTORE_AGE:-}" ;;
  *pg_stat_archiver*) printf '%s\n' "${STUB_ARCHIVED_START-1000}" ;;
  *pg_last_wal_replay_lsn*) printf '%s\n' "${STUB_REPLAYED_TO-5000}" ;;
  *query_to_xml*) echo "psql counted every table in one statement" >> "$STUB_CALLS"; exit 64 ;;
  *'\gexec'*)
    if [ "$host" = /var/run/postgresql ]; then printf '%s\n' "$STUB_LIVE"; else printf '%s\n' "$STUB_RESTORED"; fi
    ;;
  *ChatMediaReference*)
    # 三个来源都要抽：普通聊天媒体只在 ChatMessage.content 里，ChatMediaReference 只记
    # 笔记转发进聊天的那部分。
    case "$sql" in *'"ChatMessage"'*"'image', 'video', 'voice', 'file'"*) ;; *) echo "psql sample left out chat message media" >> "$STUB_CALLS" ;; esac
    case "$sql" in *'"NoteMedia"'*) ;; *) echo "psql sample left out note media" >> "$STUB_CALLS" ;; esac
    echo "psql sample limits: $(printf '%s\n' "$sql" | grep -o 'LIMIT [0-9]*' | awk '{print $2}' | tr '\n' ' ')" >> "$STUB_CALLS"
    printf '%s\n' "${STUB_OBJECT_KEYS-}"
    ;;
  *) exit 64 ;;
esac
SH
cat > "$fake_bin/du" <<'SH'
#!/usr/bin/env bash
# 跑着的集簇上 du 会因为文件中途消失而非零退出，但总数照样打印。
printf '%s\t%s\n' "${STUB_DU_KB:-1048576}" "${@: -1}"
exit "${STUB_DU_RC:-0}"
SH
cat > "$fake_bin/df" <<'SH'
#!/usr/bin/env bash
# 与真的 df 一样：路径不存在就报错。演练必须先建好 DRILL_ROOT 再量它所在的盘。
[ -e "${@: -1}" ] || { echo "df: ${@: -1}: No such file or directory" >&2; exit 1; }
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/vda1 %s 0 %s 50%% /tmp\n' "${STUB_DF_TOTAL_KB:-104857600}" "${STUB_DF_AVAIL_KB:-52428800}"
SH
# mc stat --json <alias>/<bucket>[/minio/<bucket>]/<key>，输出照抄 mc RELEASE.2025-08-13 的实测：
# - 不存在：只有一行 "Object does not exist"；
# - 凭证错、桶不在、连不上：先一行带错误码的 "Unable to list folder"，**最后同样是**
#   "Object does not exist"。只看最后一行就会把它们当成「对象不存在」。
# 键在 STUB_*_MISSING 里算不存在，在 STUB_*_ERROR 里算出错；别的子命令一律报错 ——
# 演练对对象存储只读。
cat > "$fake_bin/mc" <<'SH'
#!/usr/bin/env bash
echo "mc $*" >> "$STUB_CALLS"
[ "$1" = stat ] || exit 64
path="${@: -1}"
key="${path#*/*/}"
case "$path" in
  backup/*) key="${key#minio/*/}"; missing="${STUB_COPY_MISSING:-}"; broken="${STUB_COPY_ERROR:-}" ;;
  source/*) missing="${STUB_LIVE_MISSING:-}"; broken="${STUB_LIVE_ERROR:-}" ;;
  *) exit 64 ;;
esac
not_found='{"status":"error","error":{"message":"Unable to stat `'"$path"'`.","cause":{"message":"Object does not exist","error":{}},"type":"fatal"}}'
for k in $broken; do
  if [ "$k" = "$key" ]; then
    echo '{"status":"error","error":{"message":"Unable to list folder.","cause":{"message":"The request signature we calculated does not match the signature you provided.","error":{"Code":"SignatureDoesNotMatch"}},"type":"error"}}'
    echo "$not_found"
    exit 1
  fi
done
for k in $missing; do [ "$k" = "$key" ] && { echo "$not_found"; exit 1; }; done
echo '{"status":"success","name":"'"${key##*/}"'","size":1,"type":"file"}'
SH
# 演练给 mc 套了超时；macOS 没有 timeout，桩直接执行后面的命令。
cat > "$fake_bin/timeout" <<'SH'
#!/usr/bin/env bash
shift
exec "$@"
SH
cat > "$fake_bin/flock" <<'SH'
#!/usr/bin/env bash
[ "${STUB_FLOCK_BUSY:-0}" != "1" ]
SH
chmod +x "$fake_bin"/*

export PATH="$fake_bin:$PATH"
export BACKUP_S3_ENDPOINT=https://s3.example.test
export BACKUP_S3_BUCKET=offsite
export BACKUP_S3_KEY=key-id-not-a-metric
export BACKUP_S3_KEY_SECRET=secret-not-a-metric
export BACKUP_PG_CIPHER_PASS=cipher-not-a-metric

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

LIVE_DEFAULT=$'chat_message=5000\nnotification=40\noutbox=3\nuser=12'

# run_drill <case dir> [VAR=value...] — prints the exit code.
run_drill() {
  local dir="$1"; shift
  local rc=0
  mkdir -p "$dir/pgdata" "$dir/scratch"
  : > "$dir/calls"
  env STUB_CALLS="$dir/calls" \
      DRILL_ROOT="$dir/scratch/drill" \
      DRILL_LIVE_PGDATA="$dir/pgdata" \
      BACKUP_METRICS_DIR="$dir/metrics" \
      STUB_LIVE="$LIVE_DEFAULT" STUB_RESTORED="$LIVE_DEFAULT" STUB_RESTORE_AGE=90 \
      "$@" bash "$drill" >"$dir/out" 2>"$dir/err" || rc=$?
  printf '%s' "$rc"
}

assert_metric() {
  local file="$1" pattern="$2"
  grep -Eq "^${pattern}\$" "$file" || {
    cat "$file" >&2
    fail "expected a line matching ^${pattern}\$ in $file"
  }
}

now="$(date +%s)"

# ── 恢复成功、行数一致 ─────────────────────────────────────────────────────
dir="$tmp_dir/ok"
rc="$(run_drill "$dir")"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "passing drill exited $rc"; }
prom="$dir/metrics/backup_drill.prom"
assert_metric "$prom" '# TYPE circle_backup_drill_success gauge'
assert_metric "$prom" 'circle_backup_drill_success\{stage="complete"\} 1'
assert_metric "$prom" 'circle_backup_drill_restore_point_age_seconds 90'
assert_metric "$prom" 'circle_backup_drill_duration_seconds [0-9]+'
stamp="$(sed -n 's/^circle_backup_drill_last_run_timestamp_seconds \([0-9]*\)$/\1/p' "$prom")"
[ -n "$stamp" ] && [ "$stamp" -ge "$now" ] && [ "$stamp" -le $((now + 60)) ] \
  || fail "last-run timestamp '$stamp' is not the time of this run"
success_prom="$dir/metrics/backup_drill_last_success.prom"
assert_metric "$success_prom" "circle_backup_drill_last_success_timestamp_seconds $stamp"
[ ! -e "$dir/scratch/drill" ] || fail 'the scratch restore was not removed'
grep -q 'pg_ctl .* stop' "$dir/calls" || fail 'the scratch postmaster was not stopped'
# 不开 hot standby：否则 pg_ctl -w 在 WAL 还在回放时就返回，读到的是恢复到一半的集簇。
grep -q 'pg_ctl .*hot_standby=off.* start' "$dir/calls" || fail 'the scratch cluster was started with hot standby'
if grep -q 'counted every table in one statement' "$dir/calls"; then fail 'the live counts ran as one statement holding every table lock'; fi
# 没配对象镜像：不做对象核验，也不导出它的指标。
if grep -q '^mc ' "$dir/calls"; then fail 'the object check ran without an object mirror configured'; fi
if grep -q 'circle_backup_drill_objects' "$prom"; then fail 'object metrics exported although the check did not run'; fi
if grep -q 'inherited fd 9' "$dir/calls"; then fail 'the scratch postmaster inherited the drill lock'; fi
if grep -q '^psql PGAPPNAME=$' "$dir/calls"; then fail 'a drill query ran without PGAPPNAME'; fi
[ "$(find "$dir/metrics" -type f | wc -l | tr -d ' ')" = 2 ] || { ls -la "$dir/metrics" >&2; fail 'temporary files left behind'; }
if grep -q -e 'not-a-metric' "$prom" "$success_prom"; then fail 'a credential leaked into the metrics files'; fi

# ── 恢复点之后的删除与写入都只是漂移 ────────────────────────────────────────
# 回放到距现在约一分钟：清理任务在这期间删掉的行让 restored > live，outbox 这类
# 临时表在恢复点上可能恰好是空的。两者都不该让每周演练报警。
dir="$tmp_dir/drift"
rc="$(run_drill "$dir" STUB_RESTORED=$'chat_message=4990\nnotification=55\noutbox=0\nuser=12')"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "drift-only drill exited $rc, want 0"; }
grep -q 'rows deleted since the restore point' "$dir/out" || fail 'restored > live was not reported as drift'

# ── 有实际数据量的表恢复成空表：失败，且不刷新「最近一次通过」 ────────────────
dir="$tmp_dir/empty"
mkdir -p "$dir/metrics"
printf 'circle_backup_drill_last_success_timestamp_seconds 1000\n' > "$dir/metrics/backup_drill_last_success.prom"
rc="$(run_drill "$dir" STUB_RESTORED=$'chat_message=0\nnotification=40\noutbox=3\nuser=12')"
[ "$rc" = 1 ] || fail "empty-table drill exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="compare"\} 0'
assert_metric "$dir/metrics/backup_drill_last_success.prom" 'circle_backup_drill_last_success_timestamp_seconds 1000'

# ── 恢复里少了一张表 ───────────────────────────────────────────────────────
dir="$tmp_dir/missing"
rc="$(run_drill "$dir" STUB_RESTORED=$'chat_message=5000\nnotification=40\noutbox=3')"
[ "$rc" = 1 ] || fail "missing-table drill exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="compare"\} 0'
[ ! -e "$dir/metrics/backup_drill_last_success.prom" ] || fail 'a failing drill recorded a success'

# ── pgbackrest restore 失败 ───────────────────────────────────────────────
dir="$tmp_dir/restore-fail"
rc="$(run_drill "$dir" STUB_RESTORE_FAIL=1)"
[ "$rc" = 1 ] || fail "failed restore exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="restore"\} 0'
[ ! -e "$dir/scratch/drill" ] || fail 'a failed restore left the scratch copy behind'

# ── 恢复出来的集簇起不来 ───────────────────────────────────────────────────
dir="$tmp_dir/start-fail"
rc="$(run_drill "$dir" STUB_START_FAIL=1)"
[ "$rc" = 1 ] || fail "failed start exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="start"\} 0'

# ── 磁盘放不下第二份：不开始恢复 ───────────────────────────────────────────
# 10 GiB 的库、100 GiB 的盘只剩 15 GiB：恢复后余量跌破 20% 的保留线。
dir="$tmp_dir/no-space"
rc="$(run_drill "$dir" STUB_DU_KB=10485760 STUB_DF_AVAIL_KB=15728640)"
[ "$rc" = 1 ] || fail "no-space drill exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="space"\} 0'
if grep -q 'pgbackrest.* restore' "$dir/calls"; then fail 'restore ran although the disk could not hold it'; fi
grep -q 'not enough free disk' "$dir/err" || { cat "$dir/err" >&2; fail 'no explanation for the space refusal'; }

# du 因文件中途消失而非零退出时，用它打印的总数照常判断。
dir="$tmp_dir/du-vanished"
rc="$(run_drill "$dir" STUB_DU_RC=1)"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "du's vanished-file exit code failed the drill ($rc)"; }

# 余量刚好落在 15%~20% 之间：照样拒绝 —— 那会让 HostDiskFilling 每周响一次。
dir="$tmp_dir/near-disk-alert"
rc="$(run_drill "$dir" STUB_DU_KB=1048576 STUB_DF_AVAIL_KB=19922944)"
[ "$rc" = 1 ] || fail "a drill that would leave 17% free exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="space"\} 0'

# ── 回放没追到演练开始时已归档的最新 WAL ─────────────────────────────────────
dir="$tmp_dir/wal-behind"
rc="$(run_drill "$dir" STUB_ARCHIVED_START=9000 STUB_REPLAYED_TO=4000)"
[ "$rc" = 1 ] || fail "a restore behind the archive exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="compare"\} 0'
grep -q 'BEHIND' "$dir/err" || { cat "$dir/err" >&2; fail 'no explanation for the WAL position failure'; }

# 还什么都没归档过（新库）：没有可比的位置，不判失败。
dir="$tmp_dir/nothing-archived"
rc="$(run_drill "$dir" STUB_ARCHIVED_START= STUB_REPLAYED_TO=)"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill with nothing archived yet exited $rc, want 0"; }

# 有归档位置、却读不到回放位置：不能当成通过。
dir="$tmp_dir/replay-unknown"
rc="$(run_drill "$dir" STUB_REPLAYED_TO=)"
[ "$rc" = 1 ] || fail "a drill that could not read the replay position exited $rc, want 1"

# ── 上一轮被杀掉、留下了恢复副本（带标记）：清掉、照常跑 ─────────────────────
dir="$tmp_dir/leftover"
mkdir -p "$dir/scratch/drill/data"
: > "$dir/scratch/drill/.circle-restore-drill"
echo 16 > "$dir/scratch/drill/data/PG_VERSION"
touch "$dir/scratch/drill/data/.running"
rc="$(run_drill "$dir")"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill after an interrupted one exited $rc, want 0"; }
grep -q 'interrupted drill' "$dir/err" || fail 'the leftover restore was removed silently'
[ "$(grep -c 'pg_ctl .* stop' "$dir/calls")" -ge 1 ] || fail "the leftover's postmaster was not stopped"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="complete"\} 1'

# ── 没有标记的 PGDATA：绝不删，但要落成失败指标 ─────────────────────────────
dir="$tmp_dir/real-pgdata"
mkdir -p "$dir/scratch/drill/data"
echo 16 > "$dir/scratch/drill/data/PG_VERSION"
rc="$(run_drill "$dir")"
[ "$rc" = 1 ] || fail "a drill over a real PGDATA exited $rc, want 1"
[ -f "$dir/scratch/drill/data/PG_VERSION" ] || fail 'the drill deleted a PGDATA it did not create'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="preflight"\} 0'
if grep -q 'pgbackrest' "$dir/calls"; then fail 'restore ran over a real PGDATA'; fi

# ── DRILL_ROOT 指到了一个有别的东西的共享目录：一个文件都不删，落成失败 ─────────
dir="$tmp_dir/shared-root"
mkdir -p "$dir/shared"
echo keep > "$dir/shared/unrelated"
rc="$(run_drill "$dir" DRILL_ROOT="$dir/shared")"
[ "$rc" = 1 ] || fail "a drill pointed at a non-empty shared directory exited $rc, want 1"
[ -f "$dir/shared/unrelated" ] || fail 'the drill deleted files in a directory it did not create'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="preflight"\} 0'
if grep -q 'pgbackrest' "$dir/calls"; then fail 'restore ran in a shared directory'; fi

# 已经存在、但是空的专用目录照常接管。
dir="$tmp_dir/empty-root"
mkdir -p "$dir/scratch/drill"
rc="$(run_drill "$dir")"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill with an existing empty DRILL_ROOT exited $rc, want 0"; }

# 太浅的路径（/tmp 这一级）直接拒绝，也要留下失败指标，不能悄悄退出。
dir="$tmp_dir/shallow-root"
rc="$(run_drill "$dir" DRILL_ROOT=/circle-drill-spec-not-a-real-dir/)"
[ "$rc" = 1 ] || fail "a top-level DRILL_ROOT exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="preflight"\} 0'

# 锁文件放进 DRILL_ROOT 里：演练会把自己的锁删掉，另一轮就能同时跑起来。
dir="$tmp_dir/lock-inside-root"
rc="$(run_drill "$dir" DRILL_LOCK_FILE="$dir/scratch/drill/.drill.lock")"
[ "$rc" = 1 ] || fail "a lock inside DRILL_ROOT exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="preflight"\} 0'

# ── 对象备份抽样核验 ───────────────────────────────────────────────────────
MINIO_ENV=(BACKUP_MINIO_ENDPOINT=http://minio:9000 BACKUP_MINIO_BUCKET=media BACKUP_MINIO_ACCESS_KEY=src-key-not-a-metric BACKUP_MINIO_SECRET_KEY=src-secret-not-a-metric)
KEYS=$'chat/user-1/a.jpg\nnotes/user-2/b.png\nchat/user-3/c.mp4'

dir="$tmp_dir/objects-ok"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS")"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill whose sampled objects are all backed up exited $rc"; }
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_checked 3'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_missing 0'
grep -q '^mc stat --json backup/offsite/minio/media/chat/user-1/a.jpg' "$dir/calls" || { cat "$dir/calls" >&2; fail 'the off-host copy was not looked up under minio/<bucket>/'; }
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_gone 0'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_unverifiable 0'
if grep -Eq '^mc (rm|cp|mirror|mv)' "$dir/calls"; then fail 'the object check wrote to object storage'; fi
if grep -q 'psql sample left out' "$dir/calls"; then grep 'psql sample left out' "$dir/calls" >&2; fail 'the media sample does not cover every source'; fi

# 抽样总数不超过 DRILL_OBJECT_SAMPLE：余数先分给聊天消息、再分给笔记媒体。
sample_limits() { sed -n 's/^psql sample limits: //p' "$1/calls"; }
[ "$(sample_limits "$dir")" = '7 7 6 ' ] || fail "the default sample of 20 was split as '$(sample_limits "$dir")', want 7 7 6"
for n_want in '1:1 0 0 ' '2:1 1 0 ' '4:2 1 1 '; do
  n="${n_want%%:*}"; want="${n_want#*:}"
  dir="$tmp_dir/objects-sample-$n"
  rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS" DRILL_OBJECT_SAMPLE="$n")"
  [ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill with DRILL_OBJECT_SAMPLE=$n exited $rc"; }
  [ "$(sample_limits "$dir")" = "$want" ] || fail "DRILL_OBJECT_SAMPLE=$n was split as '$(sample_limits "$dir")', want '$want'"
done

# 线上还在、异地副本没有：镜像丢了东西，判失败；日志里不出现用户 ID。
dir="$tmp_dir/objects-missing"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS" STUB_COPY_MISSING='notes/user-2/b.png')"
[ "$rc" = 1 ] || fail "a drill with an object missing from the copy exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="objects"\} 0'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_missing 1'
grep -q 'MISSING  notes/…/b.png' "$dir/err" || { cat "$dir/err" >&2; fail 'the missing object was not reported'; }
if grep -q 'user-2' "$dir/out" "$dir/err"; then fail 'a user id from an object key reached the drill log'; fi

# 两边都没有：线上的行指着一个哪里都不存在的对象 —— 是数据问题、不是备份问题：
# 告警、计数，但只要其余的核验过了就不让演练失败。
dir="$tmp_dir/objects-gone"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS" STUB_COPY_MISSING='chat/user-3/c.mp4' STUB_LIVE_MISSING='chat/user-3/c.mp4')"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill whose missing object is gone everywhere exited $rc, want 0"; }
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_checked 2'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_gone 1'
grep -q 'GONE     chat/…/c.mp4' "$dir/err" || { cat "$dir/err" >&2; fail 'an object gone from everywhere was not warned about'; }

# 抽到的全都哪里都找不到：一个也没核验成，不能算通过。
dir="$tmp_dir/objects-all-gone"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS='chat/user-1/a.jpg' STUB_COPY_MISSING='chat/user-1/a.jpg' STUB_LIVE_MISSING='chat/user-1/a.jpg')"
[ "$rc" = 1 ] || fail "a drill that confirmed none of its sampled objects exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="objects"\} 0'

# 异地副本那边查不了（凭证、网络、桶名）：不能当成「不在」，更不能当成通过。
dir="$tmp_dir/objects-copy-error"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS" STUB_COPY_ERROR='chat/user-1/a.jpg notes/user-2/b.png chat/user-3/c.mp4')"
[ "$rc" = 1 ] || fail "a drill that could not reach the off-host copy exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="objects"\} 0'
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_unverifiable 3'

# 源 MinIO 凭证失效 —— 正是让镜像停下来的那种故障：副本里没有的对象在线上也查不了。
# 以前会被算成「两边都没有」，演练照样通过。
dir="$tmp_dir/objects-source-error"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS" STUB_COPY_MISSING='chat/user-3/c.mp4' STUB_LIVE_ERROR='chat/user-3/c.mp4')"
[ "$rc" = 1 ] || fail "a drill whose live-bucket lookup failed exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_unverifiable 1'
if grep -q 'GONE' "$dir/err"; then fail 'a failed lookup was reported as an object gone everywhere'; fi

# 窗口里没有任何媒体：照常通过，核验数为 0。
dir="$tmp_dir/objects-none"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS=)"
[ "$rc" = 0 ] || { cat "$dir/err" >&2; fail "a drill with no media to sample exited $rc, want 0"; }
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_objects_checked 0'

# 数据库对比已经失败：不再做对象核验，stage 仍然指向第一个出错的地方。
dir="$tmp_dir/objects-after-compare-failure"
rc="$(run_drill "$dir" "${MINIO_ENV[@]}" STUB_OBJECT_KEYS="$KEYS" STUB_RESTORED=$'chat_message=5000\nnotification=40\noutbox=3')"
[ "$rc" = 1 ] || fail "a drill with a missing table exited $rc, want 1"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="compare"\} 0'
if grep -q '^mc ' "$dir/calls"; then fail 'the object check ran after the database restore had already failed'; fi

# ── 另一轮演练持有锁：退出 75，什么都不写 ──────────────────────────────────
dir="$tmp_dir/busy"
mkdir -p "$dir/metrics" "$dir/scratch/drill"
printf 'circle_backup_drill_success{stage="restore"} 0\n' > "$dir/metrics/backup_drill.prom"
touch "$dir/scratch/drill/in-progress"
rc="$(run_drill "$dir" STUB_FLOCK_BUSY=1)"
[ "$rc" = 75 ] || fail "drill under a held lock exited $rc, want 75"
assert_metric "$dir/metrics/backup_drill.prom" 'circle_backup_drill_success\{stage="restore"\} 0'
[ -e "$dir/scratch/drill/in-progress" ] || fail "the second drill deleted the running drill's restore"
[ ! -s "$dir/calls" ] || fail 'the second drill ran restore steps'

# ── 指标目录写不进去：结果与退出码不受影响，但要明确警告 ───────────────────
dir="$tmp_dir/unwritable"
mkdir -p "$dir"
touch "$dir/not-a-dir"
rc="$(run_drill "$dir" BACKUP_METRICS_DIR="$dir/not-a-dir/metrics")"
[ "$rc" = 0 ] || fail "unwritable-metrics drill exited $rc, want 0"
grep -q 'could not write drill metrics' "$dir/err" || { cat "$dir/err" >&2; fail 'no warning for an unwritable metrics dir'; }

printf 'backup-drill: all assertions passed\n'
