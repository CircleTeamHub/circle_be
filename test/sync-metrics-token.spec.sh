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

printf '%s\n' 'working-token' > "$token_file"
chmod 600 "$token_file"
printf '%s\n' 'METRICS_AUTH_TOKEN=must-not-replace' > "$env_file"

if [ "$(id -u)" != "0" ]; then
  if ENV_FILE="$env_file" \
    TOKEN_FILE="$token_file" \
    PROM_UID="$prom_uid" \
    PROM_GID="$prom_gid" \
    SUDO=false \
    bash "$script"; then
    echo 'expected sync to fail when privilege is unavailable' >&2
    exit 1
  fi

  test "$(cat "$token_file")" = 'working-token'
fi

echo 'sync-metrics-token regression tests passed'
