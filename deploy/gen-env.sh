#!/usr/bin/env bash
# 生成 .env(compose 变量插值用)和 .env.production(应用配置),
# 随机密钥、两个文件的 DB 密码 / MinIO 密钥自动保持一致。
#
# 用法(在 circle_be 目录):  bash deploy/gen-env.sh <服务器公网IP>
set -euo pipefail

PUBLIC_IP="${1:?用法: bash deploy/gen-env.sh <SERVER_PUBLIC_IP>}"
cd "$(dirname "$0")/.."

if [ -f .env.production ]; then
  echo "✋ .env.production 已存在,已中止以免覆盖现有密钥。如需重建请先删除它。" >&2
  exit 1
fi

# 32+ 位随机串,去掉 / + = 以免干扰 dotenv / URL 解析
gen() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

DB_PASSWORD="$(openssl rand -hex 16)"            # hex,安全嵌入 DATABASE_URL
MINIO_ROOT_USER="circleadmin"
MINIO_ROOT_PASSWORD="$(openssl rand -hex 16)"
SECRET="$(gen)"
TEMP_CHAT_LINK_SECRET="$(gen)"
METRICS_AUTH_TOKEN="$(openssl rand -hex 24)"

cat > .env <<EOF
# docker-compose 变量插值用 —— 勿提交
DB_PASSWORD=$DB_PASSWORD
MINIO_ROOT_USER=$MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=$MINIO_ROOT_PASSWORD
EOF

cat > .env.production <<EOF
NODE_ENV=production
DATABASE_URL="postgresql://circle:$DB_PASSWORD@postgres:5432/circle?schema=public"
SECRET="$SECRET"
JWT_EXPIRES_IN=1h
REFRESH_EXPIRES_IN=30d
TEMP_CHAT_LINK_SECRET="$TEMP_CHAT_LINK_SECRET"
# ⚠️ 占位值:改成前端/设备实际访问的源(逗号分隔),否则 CORS 会拦截真实前端。
# 例:ALLOWED_ORIGINS=https://app.example.com,http://$PUBLIC_IP:3000
ALLOWED_ORIGINS=http://localhost
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
MINIO_PUBLIC_URL=http://$PUBLIC_IP:9000
EOF

chmod 600 .env .env.production
echo "✅ 已生成 .env 与 .env.production (PUBLIC_IP=$PUBLIC_IP)"
echo "   ⚠️ 记得把 .env.production 里的 ALLOWED_ORIGINS 改成真实前端源(默认是占位的 localhost)。"
echo "   OpenIM(阶段5)、LiveKit(阶段6)配置稍后再追加到 .env.production"
