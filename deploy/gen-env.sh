#!/usr/bin/env bash
# 生成 .env(compose 变量插值用)和 .env.production(应用配置),
# 随机密钥、两个文件的 DB / Redis 密码和 MinIO 密钥自动保持一致。
#
# 用法: bash deploy/gen-env.sh <公网IP> <API域名> <Admin域名> <ACME邮箱> <用户Web域名>
set -euo pipefail
umask 077
trap 'rm -f .env.tmp .env.production.tmp' EXIT

PUBLIC_IP="${1:?缺少 SERVER_PUBLIC_IP}"
API_DOMAIN="${2:?缺少 API_DOMAIN}"
ADMIN_DOMAIN="${3:?缺少 ADMIN_DOMAIN}"
ACME_EMAIL="${4:?缺少 ACME_EMAIL}"
WEB_DOMAIN="${5:?缺少 WEB_DOMAIN}"
cd "$(dirname "$0")/.."

DEPLOY_USER_NAME="$(id -un)"
DEPLOY_PRIMARY_GID="$(id -g "$DEPLOY_USER_NAME")"

user_has_gid() {
  case " $(id -G "$DEPLOY_USER_NAME") " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_private_gid() {
  local gid="$1" group_record members other_primary_users
  [[ "$gid" =~ ^[0-9]+$ ]] || {
    echo "❌ APP_ENV_GID 必须是数字 GID。" >&2
    return 1
  }
  user_has_gid "$gid" || {
    echo "❌ APP_ENV_GID=$gid 不属于部署账号 $DEPLOY_USER_NAME。" >&2
    return 1
  }
  # Production runs on Linux. Refuse 0640 when another host account shares the
  # selected group, because .env.production contains database/JWT credentials.
  if [ "$(uname -s)" = "Linux" ]; then
    command -v getent >/dev/null || {
      echo "❌ 缺少 getent，无法验证 APP_ENV_GID 是否为私有组。" >&2
      return 1
    }
    group_record="$(getent group "$gid")" || {
      echo "❌ APP_ENV_GID=$gid 在组数据库中不存在。" >&2
      return 1
    }
    members="${group_record##*:}"
    case "$members" in
      ""|"$DEPLOY_USER_NAME") ;;
      *) echo "❌ APP_ENV_GID=$gid 包含其他显式组成员，拒绝共享生产密钥。" >&2; return 1 ;;
    esac
    other_primary_users="$(getent passwd | awk -F: -v gid="$gid" -v user="$DEPLOY_USER_NAME" '$4 == gid && $1 != user { print $1 }')"
    [ -z "$other_primary_users" ] || {
      echo "❌ APP_ENV_GID=$gid 被其他账号作为主组，拒绝共享生产密钥。" >&2
      return 1
    }
  fi
}

clear_file_acl() {
  local file="$1" mode
  case "$(uname -s)" in
    Linux)
      if command -v setfacl >/dev/null; then
        setfacl -b "$file"
      else
        mode="$(LC_ALL=C ls -ld -- "$file" | awk '{ print $1 }')"
        case "$mode" in
          *+) echo "❌ $file 含扩展 ACL；请先安装 acl 包再继续。" >&2; return 1 ;;
          *) ;;
        esac
      fi
      ;;
    Darwin) chmod -N "$file" ;;
    *) echo "❌ 不支持在当前系统安全清除生产配置 ACL。" >&2; return 1 ;;
  esac
}

# Default directory ACLs override umask. Create each secrets temp file empty,
# remove inherited ACL entries, and only then write any credential bytes.
prepare_empty_secret_file() {
  local file="$1"
  rm -f "$file"
  (umask 077 && : > "$file")
  clear_file_acl "$file"
  chmod 600 "$file"
}

existing_app_env_gid=""
if [ -f .env ]; then
  existing_app_env_gid="$(sed -n 's/^APP_ENV_GID=//p' .env | tail -n 1)"
fi
if [ -n "${APP_ENV_GID:-}" ]; then
  DEPLOY_APP_ENV_GID="$APP_ENV_GID"
elif [ -n "$existing_app_env_gid" ] && user_has_gid "$existing_app_env_gid"; then
  DEPLOY_APP_ENV_GID="$existing_app_env_gid"
else
  DEPLOY_APP_ENV_GID="$DEPLOY_PRIMARY_GID"
fi
validate_private_gid "$DEPLOY_APP_ENV_GID"

# 32+ 位随机串,去掉 / + = 以免干扰 dotenv / URL 解析
gen() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

set_env_value() {
  local file="$1" key="$2" value="$3"
  local tmp="${file}.tmp"
  prepare_empty_secret_file "$tmp"
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
  if [ "$file" = ".env.production" ]; then
    chgrp "$DEPLOY_APP_ENV_GID" "$tmp"
    chmod 640 "$tmp"
  fi
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

ensure_env_csv_value() {
  local file="$1" key="$2" value="$3" current
  current="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  current="${current#\"}"
  current="${current%\"}"
  case ",$current," in
    *",$value,"*) return ;;
  esac
  if [ -n "$current" ]; then
    set_env_value "$file" "$key" "$current,$value"
  else
    set_env_value "$file" "$key" "$value"
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
  clear_file_acl .env
  chmod 600 .env
  clear_file_acl .env.production
  chgrp "$DEPLOY_APP_ENV_GID" .env.production
  chmod 640 .env.production
  grep -Eq '^API_DOMAIN=.+' .env || set_env_value .env API_DOMAIN "$API_DOMAIN"
  grep -Eq '^ADMIN_DOMAIN=.+' .env || set_env_value .env ADMIN_DOMAIN "$ADMIN_DOMAIN"
  grep -Eq '^ACME_EMAIL=.+' .env || set_env_value .env ACME_EMAIL "$ACME_EMAIL"
  grep -Eq '^WEB_DOMAIN=.+' .env || set_env_value .env WEB_DOMAIN "$WEB_DOMAIN"
  set_env_value .env APP_ENV_GID "$DEPLOY_APP_ENV_GID"
  ensure_env_csv_value .env.production ALLOWED_ORIGINS "https://$ADMIN_DOMAIN"
  ensure_env_csv_value .env.production ALLOWED_ORIGINS "https://$WEB_DOMAIN"
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
  if grep -Eq '^MINIO_ENDPOINT=http://minio:9000/?$' .env.production; then
    ensure_compose_profile bundled-storage
  fi
  chmod 600 .env
  chgrp "$DEPLOY_APP_ENV_GID" .env.production
  clear_file_acl .env.production
  chmod 640 .env.production
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

prepare_empty_secret_file .env.tmp
prepare_empty_secret_file .env.production.tmp

cat > .env.tmp <<EOF
# docker-compose 变量插值用 —— 勿提交
DB_PASSWORD=$DB_PASSWORD
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
COMPOSE_PROFILES=bundled-redis,bundled-storage
API_DOMAIN=$API_DOMAIN
ADMIN_DOMAIN=$ADMIN_DOMAIN
ACME_EMAIL=$ACME_EMAIL
WEB_DOMAIN=$WEB_DOMAIN
APP_ENV_GID=$DEPLOY_APP_ENV_GID
EOF

cat > .env.production.tmp <<EOF
NODE_ENV=production
DATABASE_URL="postgresql://circle:$DB_PASSWORD@postgres:5432/circle?schema=public"
REDIS_URL="redis://default:$REDIS_PASSWORD@redis:6379"
REDIS_ALLOW_INSECURE=true
REDIS_REQUIRED=false
SECRET="$SECRET"
JWT_EXPIRES_IN=1h
REFRESH_EXPIRES_IN=30d
TEMP_CHAT_LINK_SECRET="$TEMP_CHAT_LINK_SECRET"
# Admin Web 与用户 Web 来源;原生 App 无 Origin 头,不受此项影响。
ALLOWED_ORIGINS=https://$ADMIN_DOMAIN,https://$WEB_DOMAIN
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
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_FORCE_PATH_STYLE=true
OBJECT_STORAGE_MANAGE_BUCKET=true
EOF

chmod 600 .env.tmp
chgrp "$DEPLOY_APP_ENV_GID" .env.production.tmp
chmod 640 .env.production.tmp
mv .env.tmp .env
mv .env.production.tmp .env.production
echo "✅ 已生成 .env 与 .env.production (PUBLIC_IP=$PUBLIC_IP)"
echo "   ALLOWED_ORIGINS 已设置为 https://$ADMIN_DOMAIN,https://$WEB_DOMAIN"
echo "   LiveKit(阶段6)配置稍后再追加到 .env.production"
