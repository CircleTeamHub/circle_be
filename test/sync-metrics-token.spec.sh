#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo_root/monitoring/sync-metrics-token.sh"
grep -Eq '^[[:space:]]+container_name:[[:space:]]+circle-prometheus[[:space:]]*$' \
  "$repo_root/monitoring/docker-compose.yml"
grep -F "name=^/circle-prometheus\$" "$script" >/dev/null
tmp_dir="$(mktemp -d)"
env_file="$tmp_dir/env.production"
token_file="$tmp_dir/metrics_token"
fake_bin="$tmp_dir/bin"
sudo_log="$tmp_dir/sudo.log"
sync_marker="$tmp_dir/metrics-token-sync-required"
export METRICS_SYNC_MARKER="$sync_marker"
docker_log="$tmp_dir/docker.log"
docker_stub="$tmp_dir/docker"
cat > "$docker_stub" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [ "${1:-}" = "ps" ]; then
  [ "${PROMETHEUS_QUERY_FAIL:-0}" != "1" ] || exit 1
  [ "${PROMETHEUS_ABSENT:-0}" = "1" ] || printf 'prometheus-existing-id\n'
  exit
fi
if [ "${1:-}" = "info" ]; then
  [ "${DOCKER_INFO_FAIL:-0}" != "1" ]
  exit
fi
case "$*" in
  *' up -d --force-recreate prometheus')
    [ "${DOCKER_FAIL:-0}" != "1" ]
    ;;
  *' ps --status running -q prometheus')
    [ "${DOCKER_PS_EMPTY:-0}" = "1" ] || printf 'prometheus-test-id\n'
    ;;
esac
SH
chmod +x "$docker_stub"
export DOCKER="$docker_stub"
export DOCKER_LOG="$docker_log"

cleanup() {
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n rm -rf "$tmp_dir"
  else
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

expected_uid=65534
expected_gid=65534
prom_uid=65534
prom_gid=65534
using_fake_sudo=0

if [ "$(id -u)" != "0" ] &&
  { ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; }; then
  mkdir -p "$fake_bin"
  cat > "$fake_bin/sudo" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = '-n' ]; then
  shift
fi
printf '%s\n' "$*" >> "$SUDO_LOG"
exec "$@"
SH
  chmod +x "$fake_bin/sudo"
  export PATH="$fake_bin:$PATH"
  export SUDO_LOG="$sudo_log"
  using_fake_sudo=1
  expected_uid="$(id -u)"
  expected_gid="$(id -g)"
  prom_uid="$expected_uid"
  prom_gid="$expected_gid"
fi

run_sync() {
  : > "$sync_marker"
  ENV_FILE="$env_file" \
    TOKEN_FILE="$token_file" \
    METRICS_SYNC_MARKER="$sync_marker" \
    PROM_UID="$prom_uid" \
    PROM_GID="$prom_gid" \
  bash "$script"
  test ! -e "$sync_marker"
  grep -F 'compose -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml up -d --force-recreate prometheus' "$docker_log" >/dev/null
}

read_token_file() {
  if [ "$(id -u)" = "0" ] || [ "$using_fake_sudo" = "1" ]; then
    cat "$1"
  else
    sudo -n cat "$1"
  fi
}

printf '%s\n' 'METRICS_AUTH_TOKEN=first-token' > "$env_file"
run_sync

printf '%s\n' 'METRICS_AUTH_TOKEN=second-token' > "$env_file"
run_sync

test "$(read_token_file "$token_file")" = 'second-token'
if [ "$using_fake_sudo" = "1" ]; then
  grep -F "install -m 600 -o $expected_uid -g $expected_gid" "$sudo_log" >/dev/null
  grep -F 'mv -f' "$sudo_log" >/dev/null
else
  test "$(stat -c '%a' "$token_file")" = '600'
  test "$(stat -c '%u' "$token_file")" = "$expected_uid"
  test "$(stat -c '%g' "$token_file")" = "$expected_gid"
fi

# A failed sync must never consume gen-env's durable reminder. Model Docker's
# accidental non-empty directory at the bind-mount source: validation succeeds,
# replacement fails, and the marker must remain for the next operator run.
failed_token_path="$tmp_dir/non-empty-token-dir"
failed_sync_marker="$tmp_dir/failed-sync-required"
mkdir -p "$failed_token_path"
printf 'keep\n' > "$failed_token_path/content"
printf '%s\n' 'METRICS_AUTH_TOKEN=valid-but-unsynced' > "$env_file"
: > "$failed_sync_marker"
if ENV_FILE="$env_file" \
  TOKEN_FILE="$failed_token_path" \
  METRICS_SYNC_MARKER="$failed_sync_marker" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  bash "$script" >"$tmp_dir/failed-sync.log" 2>&1; then
  echo 'expected metrics sync to reject a non-empty token directory' >&2
  exit 1
fi
test -e "$failed_sync_marker"

docker_unavailable_token="$tmp_dir/docker-unavailable-token"
docker_unavailable_marker="$tmp_dir/docker-unavailable-required"
printf '%s\n' 'METRICS_AUTH_TOKEN=docker-unavailable-token' > "$env_file"
: > "$docker_unavailable_marker"
if DOCKER_INFO_FAIL=1 \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$docker_unavailable_token" \
  METRICS_SYNC_MARKER="$docker_unavailable_marker" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  bash "$script" >"$tmp_dir/docker-unavailable.log" 2>&1; then
  echo 'expected metrics sync to retain the marker when Docker is unavailable' >&2
  exit 1
fi
test -e "$docker_unavailable_marker"

query_failure_token="$tmp_dir/query-failure-token"
query_failure_marker="$tmp_dir/query-failure-required"
printf '%s\n' 'METRICS_AUTH_TOKEN=query-failure-token' > "$env_file"
: > "$query_failure_marker"
if PROMETHEUS_QUERY_FAIL=1 \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$query_failure_token" \
  METRICS_SYNC_MARKER="$query_failure_marker" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  bash "$script" >"$tmp_dir/query-failure.log" 2>&1; then
  echo 'expected metrics sync to retain the marker when container query fails' >&2
  exit 1
fi
test -e "$query_failure_marker"

bootstrap_token_file="$tmp_dir/bootstrap-token"
bootstrap_sync_marker="$tmp_dir/bootstrap-sync-required"
bootstrap_log="$tmp_dir/bootstrap-docker.log"
printf '%s\n' 'METRICS_AUTH_TOKEN=bootstrap-token' > "$env_file"
: > "$bootstrap_sync_marker"
PROMETHEUS_ABSENT=1 \
  DOCKER_LOG="$bootstrap_log" \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$bootstrap_token_file" \
  METRICS_SYNC_MARKER="$bootstrap_sync_marker" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  bash "$script" >"$tmp_dir/bootstrap.log"
test ! -e "$bootstrap_sync_marker"
grep -F 'ps -aq --filter name=^/circle-prometheus$' "$bootstrap_log" >/dev/null
if grep -F 'compose ' "$bootstrap_log" >/dev/null; then
  echo 'first bootstrap must not parse production Compose before monitoring/.env exists' >&2
  exit 1
fi

recreate_token_file="$tmp_dir/recreate-failure-token"
recreate_sync_marker="$tmp_dir/recreate-failure-required"
printf '%s\n' 'METRICS_AUTH_TOKEN=recreate-failure-token' > "$env_file"
: > "$recreate_sync_marker"
if DOCKER_FAIL=1 \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$recreate_token_file" \
  METRICS_SYNC_MARKER="$recreate_sync_marker" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  bash "$script" >"$tmp_dir/recreate-failure.log" 2>&1; then
  echo 'expected metrics sync to fail when Prometheus recreate fails' >&2
  exit 1
fi
test -e "$recreate_sync_marker"

verify_token_file="$tmp_dir/verify-failure-token"
verify_sync_marker="$tmp_dir/verify-failure-required"
printf '%s\n' 'METRICS_AUTH_TOKEN=verify-failure-token' > "$env_file"
: > "$verify_sync_marker"
if DOCKER_PS_EMPTY=1 \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$verify_token_file" \
  METRICS_SYNC_MARKER="$verify_sync_marker" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  bash "$script" >"$tmp_dir/verify-failure.log" 2>&1; then
  echo 'expected metrics sync to fail when Prometheus is not running' >&2
  exit 1
fi
test -e "$verify_sync_marker"

# A production sudoers policy may authorize only the two commands the sync
# needs. Simulate that policy even when this suite itself runs as root: the fake
# id keeps the script on its non-root path, while fake sudo rejects `true` and
# permits only install/mv.
least_bin="$tmp_dir/least-privilege-bin"
least_sudo_log="$tmp_dir/least-privilege-sudo.log"
least_token_file="$tmp_dir/least-privilege-token"
real_sudo="$(command -v sudo || :)"
mkdir -p "$least_bin"
cat > "$least_bin/id" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  -u) printf '%s\n' 1000 ;;
  -un) printf '%s\n' deploy ;;
  *) exec /usr/bin/id "$@" ;;
esac
SH
cat > "$least_bin/sudo" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = '-n' ]; then
  shift
fi
printf '%s\n' "$*" >> "$LEAST_SUDO_LOG"
case "${1:-}" in
  install | mv)
    if [ -n "${REAL_SUDO:-}" ] && [ "$(/usr/bin/id -u)" != "0" ]; then
      exec "$REAL_SUDO" -n "$@"
    fi
    exec "$@"
    ;;
  *) exit 1 ;;
esac
SH
chmod +x "$least_bin/id" "$least_bin/sudo"

printf '%s\n' 'METRICS_AUTH_TOKEN=least-privilege-token' > "$env_file"
PATH="$least_bin:$PATH" \
  LEAST_SUDO_LOG="$least_sudo_log" \
  REAL_SUDO="$real_sudo" \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$least_token_file" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  SUDO="$least_bin/sudo" \
  bash "$script" >/dev/null

test "$(read_token_file "$least_token_file")" = 'least-privilege-token'
grep -F 'install -m 600' "$least_sudo_log" >/dev/null
grep -F 'mv -f' "$least_sudo_log" >/dev/null
if grep -F 'true' "$least_sudo_log" >/dev/null; then
  echo 'sync must not require sudo permission for true' >&2
  exit 1
fi

# stat is GNU on CI and BSD on a dev Mac; both spellings are needed because the
# unprivileged path below is exactly the one a developer runs locally.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# Without privilege the two cases must diverge — collapsing them into one hard
# failure is what made this script unrunnable during local development.

# (1) Token already owned by somebody else: on a deployed host the first sync
# ran as root, so it belongs to Prometheus. Replacing it as the deploy user
# hands ownership over and Prometheus 401s with no symptom but dark metrics.
# Constructing that precondition needs root, so skip where we cannot.
# $using_fake_sudo means the stub on PATH only logs and execs — it grants no
# privilege, so it cannot build this precondition and must not be consulted.
foreign_file="$tmp_dir/foreign_token"
if [ "$(id -u)" = "0" ]; then
  install -m 600 -o 1 -g 1 /dev/null "$foreign_file" 2>/dev/null || :
elif [ "$using_fake_sudo" != "1" ] && sudo -n true 2>/dev/null; then
  sudo -n install -m 600 -o 1 -g 1 /dev/null "$foreign_file" 2>/dev/null || :
fi

if [ "$(id -u)" != "0" ] && [ -e "$foreign_file" ] && [ ! -O "$foreign_file" ]; then
  printf '%s\n' 'METRICS_AUTH_TOKEN=must-not-replace' > "$env_file"
  if ENV_FILE="$env_file" \
    TOKEN_FILE="$foreign_file" \
    PROM_UID="$prom_uid" \
    PROM_GID="$prom_gid" \
    SUDO=false \
    bash "$script"; then
    echo 'expected sync to refuse replacing a token owned by another user' >&2
    exit 1
  fi
fi

# (2) Token absent or already ours: fail by default because a real Linux host
# cannot serve metrics from the resulting current-user-owned 0600 file.
local_file="$tmp_dir/local_token"
printf '%s\n' 'METRICS_AUTH_TOKEN=local-dev-token' > "$env_file"
: > "$sync_marker"
if local_out="$(ALLOW_UNPRIVILEGED_METRICS_TOKEN=0 \
  PATH="$least_bin:$PATH" \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$local_file" \
  PROM_UID=65534 \
  PROM_GID=65534 \
  SUDO=false \
  bash "$script" 2>&1)"; then
  echo 'expected unprivileged sync to fail without an explicit local-development override' >&2
  exit 1
fi

test "$(cat "$local_file")" = 'local-dev-token'
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) test "$(file_mode "$local_file")" = '600' ;;
esac
printf '%s' "$local_out" | grep -F 'cannot read a 0600 file' >/dev/null
printf '%s' "$local_out" | grep -F 'ALLOW_UNPRIVILEGED_METRICS_TOKEN=1' >/dev/null
printf '%s' "$local_out" | grep -F 'Configure passwordless sudo for install and mv, or run this script as root.' >/dev/null
printf '%s' "$local_out" | grep -F '修复权限后重新运行本脚本' >/dev/null
if printf '%s' "$local_out" | grep -F 'sudo chown' >/dev/null; then
  echo 'sync failure must not recommend a chown that makes the next unprivileged run fail' >&2
  exit 1
fi
test -e "$sync_marker"

# Docker Desktop maps uids for local development. Keep that compatibility only
# behind an explicit opt-in, including subsequent rotations.
printf '%s\n' 'METRICS_AUTH_TOKEN=local-dev-rotated' > "$env_file"
local_out="$(ALLOW_UNPRIVILEGED_METRICS_TOKEN=1 \
  PATH="$least_bin:$PATH" \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$local_file" \
  PROM_UID=65534 \
  PROM_GID=65534 \
  SUDO=false \
  bash "$script")"

test "$(cat "$local_file")" = 'local-dev-rotated'
printf '%s' "$local_out" | grep -F 'cannot read a 0600 file' >/dev/null
test -e "$sync_marker"
# Nothing is broken on the opt-in path, so it must not tell the operator to fix
# permissions; it must say the marker is kept and the override is per-rotation.
printf '%s' "$local_out" | grep -F 'intentionally retained' >/dev/null
printf '%s' "$local_out" | grep -F 'again on every rotation' >/dev/null
if printf '%s' "$local_out" | grep -F '修复权限后重新运行本脚本' >/dev/null; then
  echo 'opt-in success must not instruct the operator to fix permissions' >&2
  exit 1
fi

# (3) Deploy uid equals PROM_UID (rootless Podman, or a container run as the
# host user). A 0600 file is readable by exactly its owner uid, so this is a
# complete sync: exit 0 with no override, Prometheus recreated, marker cleared.
# The fake id on $least_bin reports uid 1000, which keeps this deterministic
# whether or not the suite itself runs as root.
matching_uid_file="$tmp_dir/matching-uid-token"
matching_uid_log="$tmp_dir/matching-uid-docker.log"
printf '%s\n' 'METRICS_AUTH_TOKEN=matching-uid-token' > "$env_file"
: > "$sync_marker"
local_out="$(ALLOW_UNPRIVILEGED_METRICS_TOKEN=0 \
  PATH="$least_bin:$PATH" \
  DOCKER_LOG="$matching_uid_log" \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$matching_uid_file" \
  PROM_UID=1000 \
  PROM_GID=1000 \
  SUDO=false \
  bash "$script" 2>&1)"

test "$(cat "$matching_uid_file")" = 'matching-uid-token'
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) test "$(file_mode "$matching_uid_file")" = '600' ;;
esac
test ! -e "$sync_marker"
grep -F 'up -d --force-recreate prometheus' "$matching_uid_log" >/dev/null
printf '%s' "$local_out" | grep -F 'uid 1000' >/dev/null
if printf '%s' "$local_out" | grep -F 'cannot read a 0600 file' >/dev/null; then
  echo 'a deploy uid equal to PROM_UID must not be reported as unreadable' >&2
  exit 1
fi
if printf '%s' "$local_out" | grep -F 'ALLOW_UNPRIVILEGED_METRICS_TOKEN' >/dev/null; then
  echo 'a deploy uid equal to PROM_UID must not require the local-development override' >&2
  exit 1
fi

echo 'sync-metrics-token regression tests passed'
