#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo_root/monitoring/sync-metrics-token.sh"
tmp_dir="$(mktemp -d)"
env_file="$tmp_dir/env.production"
token_file="$tmp_dir/metrics_token"
fake_bin="$tmp_dir/bin"
sudo_log="$tmp_dir/sudo.log"

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
  ENV_FILE="$env_file" \
    TOKEN_FILE="$token_file" \
    PROM_UID="$prom_uid" \
    PROM_GID="$prom_gid" \
    bash "$script"
}

printf '%s\n' 'METRICS_AUTH_TOKEN=first-token' > "$env_file"
run_sync

printf '%s\n' 'METRICS_AUTH_TOKEN=second-token' > "$env_file"
run_sync

test "$(cat "$token_file")" = 'second-token'
if [ "$using_fake_sudo" = "1" ]; then
  grep -F "install -m 600 -o $expected_uid -g $expected_gid" "$sudo_log" >/dev/null
  grep -F 'mv -f' "$sudo_log" >/dev/null
else
  test "$(stat -c '%a' "$token_file")" = '600'
  test "$(stat -c '%u' "$token_file")" = "$expected_uid"
  test "$(stat -c '%g' "$token_file")" = "$expected_gid"
fi

# A production sudoers policy may authorize only the two commands the sync
# needs. Simulate that policy even when this suite itself runs as root: the fake
# id keeps the script on its non-root path, while fake sudo rejects `true` and
# permits only install/mv.
least_bin="$tmp_dir/least-privilege-bin"
least_sudo_log="$tmp_dir/least-privilege-sudo.log"
least_token_file="$tmp_dir/least-privilege-token"
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
  install | mv) exec "$@" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$least_bin/id" "$least_bin/sudo"

printf '%s\n' 'METRICS_AUTH_TOKEN=least-privilege-token' > "$env_file"
PATH="$least_bin:$PATH" \
  LEAST_SUDO_LOG="$least_sudo_log" \
  ENV_FILE="$env_file" \
  TOKEN_FILE="$least_token_file" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  SUDO="$least_bin/sudo" \
  bash "$script" >/dev/null

test "$(cat "$least_token_file")" = 'least-privilege-token'
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

# (2) Token absent or already ours: local development. Docker Desktop maps uids
# so Prometheus can still read it; failing here only blocks bringing monitoring
# up locally. Write it, warn loudly, exit 0.
local_file="$tmp_dir/local_token"
printf '%s\n' 'METRICS_AUTH_TOKEN=local-dev-token' > "$env_file"
local_out="$(ENV_FILE="$env_file" \
  TOKEN_FILE="$local_file" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  SUDO=false \
  bash "$script")"

test "$(cat "$local_file")" = 'local-dev-token'
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) ;;
  *) test "$(file_mode "$local_file")" = '600' ;;
esac
printf '%s' "$local_out" | grep -F 'cannot read a 0600 file' >/dev/null

# Rotation still has to work on the following run — the file is ours now, which
# must not be mistaken for the "owned by somebody else" case above.
printf '%s\n' 'METRICS_AUTH_TOKEN=local-dev-rotated' > "$env_file"
ENV_FILE="$env_file" \
  TOKEN_FILE="$local_file" \
  PROM_UID="$prom_uid" \
  PROM_GID="$prom_gid" \
  SUDO=false \
  bash "$script" >/dev/null

test "$(cat "$local_file")" = 'local-dev-rotated'

echo 'sync-metrics-token regression tests passed'
