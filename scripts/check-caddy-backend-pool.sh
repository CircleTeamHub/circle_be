#!/usr/bin/env bash
# 用真实的 Caddy 二进制检查 deploy/Caddyfile.admin 里后端上游的两条路径。
#
#   bash scripts/check-caddy-backend-pool.sh <带 rate_limit 模块的 Caddy 镜像>
#
# 1. 单实例(默认):`import circle_be_lb_{$CIRCLE_BE_LB:single}` 必须什么都不加。
#    做法是把那一节(两个片段)和三处 import 从 Caddyfile 里删掉,两份各 `caddy adapt`
#    一次,生成的 JSON 必须逐字节相同 —— 默认上游和发版时传入单个上游两种情况都比。
#    scripts/release-hardening.test.mjs 的正则只能看出文本在不在,看不出 Caddy 是否
#    真的在 import 的名字里展开环境变量、空片段是否合法。
# 2. 多实例:发版脚本传的是空格分隔的多个上游加 CIRCLE_BE_LB=pool,必须通过
#    `caddy validate`,且三处 reverse_proxy 都拿到全部上游、least_conn 和探活。
set -euo pipefail

image="${1:?usage: check-caddy-backend-pool.sh <caddy image>}"
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 没有多实例支持时的 Caddyfile:去掉负载均衡那一节和三处 import;只含 import 的
# 那个块(管理域 /api/*)还原成不带块的写法。
awk '
  /^# ── 后端上游的负载均衡/ { skipping = 1 }
  skipping && /^# ── 限流说明/ { skipping = 0 }
  skipping { next }
  /import circle_be_lb_/ { next }
  held != "" {
    if ($0 ~ /^[[:space:]]*}[[:space:]]*$/) {
      sub(/ {$/, "", held)
      print held
      held = ""
      next
    }
    print held
    held = ""
  }
  /reverse_proxy \{\$CIRCLE_BE_UPSTREAM:circle-be-blue:3000\} \{$/ { held = $0; next }
  { print }
  END { if (held != "") print held }
' deploy/Caddyfile.admin > "$work/Caddyfile.without-pool"

if grep -q 'circle_be_lb' "$work/Caddyfile.without-pool"; then
  echo 'could not strip the backend pool hook from deploy/Caddyfile.admin' >&2
  exit 1
fi
[ "$(grep -c 'import circle_be_lb_{\$CIRCLE_BE_LB:single}' deploy/Caddyfile.admin)" = 3 ] || {
  echo 'expected exactly three backend pool imports in deploy/Caddyfile.admin' >&2
  exit 1
}

adapt() {
  local file="$1" out="$2"
  shift 2
  docker run --rm -i \
    -e API_DOMAIN=api.example.test \
    -e ADMIN_DOMAIN=admin.example.test \
    -e ACME_EMAIL=ops@example.test \
    "$@" --entrypoint caddy "$image" \
    adapt --config /dev/stdin --adapter caddyfile < "$file" > "$out" 2> "$out.log" ||
    { cat "$out.log" >&2; return 1; }
}

for upstream in '' 'circle-be-green:3000'; do
  env_args=()
  [ -z "$upstream" ] || env_args=(-e "CIRCLE_BE_UPSTREAM=$upstream")
  adapt deploy/Caddyfile.admin "$work/with.json" ${env_args[@]+"${env_args[@]}"}
  adapt "$work/Caddyfile.without-pool" "$work/without.json" ${env_args[@]+"${env_args[@]}"}
  if ! cmp -s "$work/with.json" "$work/without.json"; then
    echo "The backend pool hook changes the single-upstream config (CIRCLE_BE_UPSTREAM='${upstream:-default}'):" >&2
    echo "  adapted JSON is $(wc -c < "$work/without.json" | tr -d ' ') bytes without the hook, $(wc -c < "$work/with.json" | tr -d ' ') with it." >&2
    echo "  circle_be_lb_single must stay empty; put pool-only directives in circle_be_lb_pool." >&2
    exit 1
  fi
  echo "ok: single upstream '${upstream:-default}' adapts byte-identically without the pool hook"
done

pool='circle-be-green:3000 circle-be-green-2:3000'
docker run --rm -i \
  -e API_DOMAIN=api.example.test -e ADMIN_DOMAIN=admin.example.test \
  -e ACME_EMAIL=ops@example.test \
  -e "CIRCLE_BE_UPSTREAM=$pool" -e CIRCLE_BE_LB=pool \
  --entrypoint caddy "$image" \
  validate --config /dev/stdin --adapter caddyfile < deploy/Caddyfile.admin > "$work/validate.log" 2>&1 ||
  { cat "$work/validate.log" >&2; exit 1; }
adapt deploy/Caddyfile.admin "$work/pool.json" -e "CIRCLE_BE_UPSTREAM=$pool" -e CIRCLE_BE_LB=pool
count() { grep -o "$1" "$work/pool.json" | wc -l | tr -d ' '; }
[ "$(count '"dial":"circle-be-green:3000"')" = 3 ] &&
  [ "$(count '"dial":"circle-be-green-2:3000"')" = 3 ] &&
  [ "$(count '"policy":"least_conn"')" = 3 ] &&
  [ "$(count '"uri":"/healthz"')" = 3 ] || {
  echo 'pooled config is missing an upstream, least_conn or the health check on a backend route' >&2
  exit 1
}
echo 'ok: two upstreams with CIRCLE_BE_LB=pool validate and reach all three backend routes'
