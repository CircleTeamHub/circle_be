#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT_DIR/deploy/release-force-command.sh"
CASE_DIR="$(mktemp -d)"
DEPLOY_ROOT="$CASE_DIR/circle_be"
DEPLOY_HOME="$CASE_DIR/deploy-home"
STATE_DIR="$DEPLOY_ROOT/.release"
LOG="$STATE_DIR/activation.log"
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
STAGE="123-1-$SHA"
trap 'rm -rf "$CASE_DIR"' EXIT

mkdir -p "$STATE_DIR" "$DEPLOY_HOME" "$CASE_DIR/source/deploy"
printf 'payload\n' > "$CASE_DIR/source/VERSION"
printf '#!/usr/bin/env bash\n' > "$CASE_DIR/source/deploy/release-deploy.sh"
printf '0\n' > "$CASE_DIR/source/deploy/SCHEMA_COMPATIBILITY"
tar -C "$CASE_DIR/source" -czf "$CASE_DIR/stage.tar.gz" .

cat > "$STATE_DIR/release-launcher.sh" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'stage=%s\n' "$1"
  printf 'schema=%s\n' "$TARGET_SCHEMA_COMPATIBILITY"
  printf 'tag=%s\n' "$RELEASE_TAG"
  printf 'image=%s\n' "$CIRCLE_BE_IMAGE"
  printf 'downtime=%s\n' "$RELEASE_DOWNTIME"
  printf 'irreversible=%s\n' "$RELEASE_IRREVERSIBLE_MIGRATION"
  printf 'user=%s\n' "$GHCR_USER"
  printf 'token=%s\n' "$GHCR_TOKEN"
  printf 'home=%s\n' "$HOME"
} > "$RELEASE_STATE_DIR/activation.log"
LAUNCHER
chmod 0555 "$STATE_DIR/release-launcher.sh"

run_gate() {
  local command="$1"
  shift
  HOME="$DEPLOY_HOME" SSH_ORIGINAL_COMMAND="$command" bash "$GATE" "$DEPLOY_ROOT" "$@"
}

run_gate "circle-release stage $STAGE $SHA" < "$CASE_DIR/stage.tar.gz"
[ "$(cat "$STATE_DIR/incoming/$STAGE/VERSION")" = payload ]
[ "$(cat "$STATE_DIR/incoming/$STAGE/.release-source-sha")" = "$SHA" ]

{
  printf '%s\n' \
    0 \
    v1.2.3 \
    ghcr.io/circleteamhub/circle_be@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    0 \
    0 \
    'github-actions[bot]' \
    test-token
} | run_gate "circle-release activate $STAGE"

grep -q '^stage=123-1-' "$LOG"
grep -q '^schema=0$' "$LOG"
grep -q '^tag=v1.2.3$' "$LOG"
grep -q '^image=ghcr.io/circleteamhub/circle_be@sha256:b\{64\}$' "$LOG"
grep -q '^user=github-actions\[bot\]$' "$LOG"
grep -q '^token=test-token$' "$LOG"
grep -Fqx "home=$DEPLOY_HOME" "$LOG"

# 启动器不可信(部署账号可写)是服务器侧的配置问题。activate 必须拒绝,但刚上传
# 完的发布包要原样留着 —— 清理钩子装在校验之前的话,运维改好配置后还得让 CI 把
# 整包重传一次。
KEEP_STAGE="124-1-$SHA"
run_gate "circle-release stage $KEEP_STAGE $SHA" < "$CASE_DIR/stage.tar.gz"
chmod 0755 "$STATE_DIR/release-launcher.sh"
if {
  printf '%s\n' \
    0 \
    v1.2.3 \
    ghcr.io/circleteamhub/circle_be@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
    0 \
    0 \
    'github-actions[bot]' \
    test-token
} | run_gate "circle-release activate $KEEP_STAGE" >"$CASE_DIR/untrusted.log" 2>&1; then
  echo "unexpectedly activated through a deploy-account-writable launcher" >&2
  exit 1
fi
if [ ! -d "$STATE_DIR/incoming/$KEEP_STAGE" ]; then
  echo "staged release was destroyed by a server-side launcher misconfiguration" >&2
  exit 1
fi
chmod 0555 "$STATE_DIR/release-launcher.sh"

for rejected in \
  'bash -s' \
  'bash deploy/release-deploy.sh' \
  'circle-release install-launcher' \
  "circle-release activate $STAGE extra" \
  "circle-release stage ../../escape $SHA" \
  "circle-release stage 123-1-$SHA cccccccccccccccccccccccccccccccccccccccc"; do
  if run_gate "$rejected" </dev/null >"$CASE_DIR/rejected.log" 2>&1; then
    echo "unexpectedly accepted command: $rejected" >&2
    exit 1
  fi
done

printf 'PASS release ForceCommand protocol rejects general SSH commands\n'
