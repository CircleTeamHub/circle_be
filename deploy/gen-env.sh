#!/usr/bin/env bash
# 生成 .env(compose 变量插值用)和 .env.production(应用配置),
# 随机密钥、两个文件的 DB / Redis 密码和 MinIO 密钥自动保持一致。
#
# 用法: bash deploy/gen-env.sh <公网IP> <API域名> <Admin域名> <ACME邮箱>
set -euo pipefail
umask 077
trap 'rm -f .env.tmp .env.production.tmp' EXIT

PUBLIC_IP="${1:?缺少 SERVER_PUBLIC_IP}"
API_DOMAIN="${2:?缺少 API_DOMAIN}"
ADMIN_DOMAIN="${3:?缺少 ADMIN_DOMAIN}"
ACME_EMAIL="${4:?缺少 ACME_EMAIL}"
cd "$(dirname "$0")/.."

# 32+ 位随机串,去掉 / + = 以免干扰 dotenv / URL 解析
gen() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

set_env_value() {
  local file="$1" key="$2" value="$3"
  local tmp="${file}.tmp"
  awk -v key="$key" -v value="$value" '
    BEGIN { prefix = key "="; replaced = 0 }
    index($0, prefix) == 1 {
      if (!replaced) print prefix value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print prefix value }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

ensure_compose_profile() {
  local profile="$1" current
  current="$(sed -n 's/^COMPOSE_PROFILES=//p' .env | tail -n 1)"
  case ",$current," in
    *",$profile,"*) return ;;
  esac
  if [ -n "$current" ]; then
    set_env_value .env COMPOSE_PROFILES "$current,$profile"
  else
    set_env_value .env COMPOSE_PROFILES "$profile"
  fi
}

if [ -f .env.production ]; then
  if [ ! -f .env ]; then
    echo "❌ .env.production 已存在但 .env 缺失;拒绝生成不完整的 Compose 配置。" >&2
    exit 1
  fi
  for key in DB_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
    if ! grep -Eq "^${key}=.+" .env; then
      echo "❌ .env 缺少必填项 ${key};请先恢复现有部署配置。" >&2
      exit 1
    fi
  done
  grep -Eq '^API_DOMAIN=.+' .env || set_env_value .env API_DOMAIN "$API_DOMAIN"
  grep -Eq '^ADMIN_DOMAIN=.+' .env || set_env_value .env ADMIN_DOMAIN "$ADMIN_DOMAIN"
  grep -Eq '^ACME_EMAIL=.+' .env || set_env_value .env ACME_EMAIL "$ACME_EMAIL"
  if grep -q '^REDIS_PASSWORD=' .env; then
    REDIS_PASSWORD="$(sed -n 's/^REDIS_PASSWORD=//p' .env | tail -n 1)"
  fi
  if ! printf '%s' "${REDIS_PASSWORD:-}" | grep -Eq '^[a-f0-9]{48}$'; then
    REDIS_PASSWORD="$(openssl rand -hex 24)"
    set_env_value .env REDIS_PASSWORD "$REDIS_PASSWORD"
  fi
  grep -q '^REDIS_URL=' .env.production || printf '\nREDIS_URL="redis://default:%s@redis:6379"\n' "$REDIS_PASSWORD" >> .env.production
  if grep -Eq '^REDIS_URL=.*@redis:6379' .env.production; then
    set_env_value .env.production REDIS_URL "\"redis://default:$REDIS_PASSWORD@redis:6379\""
    ensure_compose_profile bundled-redis
    grep -q '^REDIS_ALLOW_INSECURE=' .env.production || printf 'REDIS_ALLOW_INSECURE=true\n' >> .env.production
  else
    grep -q '^REDIS_ALLOW_INSECURE=' .env.production || printf 'REDIS_ALLOW_INSECURE=false\n' >> .env.production
  fi
  grep -q '^REDIS_REQUIRED=' .env.production || printf 'REDIS_REQUIRED=false\n' >> .env.production
  if ! grep -Eq '^METRICS_AUTH_TOKEN=.{32,}$' .env.production; then
    set_env_value .env.production METRICS_AUTH_TOKEN "$(openssl rand -hex 24)"
  fi
  if ! grep -Eq '^MINIO_PUBLIC_URL=https://' .env.production; then
    set_env_value .env.production MINIO_PUBLIC_URL "https://$API_DOMAIN"
  fi
  chmod 600 .env .env.production
  echo "✅ 已保留现有配置并补齐 Redis 配置"
  exit 0
fi

DB_PASSWORD="$(openssl rand -hex 16)"            # hex,安全嵌入 DATABASE_URL
MINIO_ROOT_USER="circleadmin"
MINIO_ROOT_PASSWORD="$(openssl rand -hex 16)"
REDIS_PASSWORD="$(openssl rand -hex 24)"       # hex,安全嵌入 REDIS_URL
SECRET="$(gen)"
TEMP_CHAT_LINK_SECRET="$(gen)"
METRICS_AUTH_TOKEN="$(openssl rand -hex 24)"

cat > .env <<EOF
# docker-compose 变量插值用 —— 勿提交
DB_PASSWORD=$DB_PASSWORD
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
COMPOSE_PROFILES=bundled-redis
API_DOMAIN=$API_DOMAIN
ADMIN_DOMAIN=$ADMIN_DOMAIN
ACME_EMAIL=$ACME_EMAIL
EOF

cat > .env.production <<EOF
NODE_ENV=production
DATABASE_URL="postgresql://circle:$DB_PASSWORD@postgres:5432/circle?schema=public"
REDIS_URL="redis://default:$REDIS_PASSWORD@redis:6379"
REDIS_ALLOW_INSECURE=true
REDIS_REQUIRED=false
SECRET="$SECRET"
JWT_EXPIRES_IN=1h
REFRESH_EXPIRES_IN=30d
TEMP_CHAT_LINK_SECRET="$TEMP_CHAT_LINK_SECRET"
# Web 管理端来源;原生 App 无 Origin 头,不受此项影响。
ALLOWED_ORIGINS=https://$ADMIN_DOMAIN
APP_PORT=3000
LOG_ON=true
LOG_LEVEL=info
TIMESTAMP=true
HTTP_LOG_ON=true
SLOW_REQUEST_MS=1000
BUSINESS_LOG_ON=true
EXTERNAL_LOG_ON=true
RATE_LIMIT_LOG_ON=true
METRICS_AUTH_TOKEN=$METRICS_AUTH_TOKEN
MINIO_ENDPOINT=http://minio:9000
MINIO_ACCESS_KEY=$MINIO_ROOT_USER
MINIO_SECRET_KEY=$MINIO_ROOT_PASSWORD
MINIO_BUCKET=circle
MINIO_PUBLIC_URL=https://$API_DOMAIN
EOF

chmod 600 .env .env.production
echo "✅ 已生成 .env 与 .env.production (PUBLIC_IP=$PUBLIC_IP)"
echo "   ALLOWED_ORIGINS 已设置为 https://$ADMIN_DOMAIN"
echo "   OpenIM(阶段5)、LiveKit(阶段6)配置稍后再追加到 .env.production"
