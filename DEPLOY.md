# circle_be 部署手册(测试环境 · Oracle ARM)

让测试人员访问全功能后端。一台服务器用 docker-compose 自托管:

| 阶段 | 内容 | 组件 |
|------|------|------|
| 4 | 核心后端 | circle_be + PostgreSQL + MinIO |
| 5 | 实时聊天 | OpenIM 全套(Mongo/Redis/Kafka) |
| 6 | 音视频 | LiveKit Cloud(免费层,不自托管) |

本文件覆盖**阶段 4**;阶段 5/6 见末尾预告。

---

## 0. 前置

- Oracle Always Free 实例:Ubuntu 22.04 / ARM64 / 2 OCPU / 12 GB
- 已能用 `ssh -i ~/.ssh/circle_oracle ubuntu@<公网IP>` 登录

## 1. 安装 Docker(服务器上,一次性)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker version && docker compose version
```

## 2. 放行端口(两层都要开)

**A. Oracle 控制台** → VCN → 对应子网的 Security List → Ingress Rules,加入(Source `0.0.0.0/0`,TCP):
`3000`(API)、`9000`(MinIO)、`9001`(MinIO 控制台,建议只填你自己的 IP)。

**B. 实例内 iptables**(Oracle 的 Ubuntu 镜像默认只放行 22):

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 9000 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 9001 -j ACCEPT
sudo netfilter-persistent save   # 持久化,重启不丢
```

## 3. 上传代码

本地(Mac)circle_be 目录执行 —— rsync 整个仓库(排除 node_modules/dist):

```bash
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git \
  -e "ssh -i ~/.ssh/circle_oracle" \
  ./ ubuntu@<公网IP>:~/circle_be/
```

## 4. 生成配置并启动核心栈

服务器上:

```bash
cd ~/circle_be
bash deploy/gen-env.sh <公网IP>        # 生成 .env 与 .env.production(随机密钥)
docker compose -f docker-compose.prod.yml up -d --build
```

启动顺序由 `depends_on` 保证:`postgres`(healthy)→ `migrate` + `minio-init`(跑完退出)→ `circle_be`。
首次 `--build` 在 ARM 上约需几分钟。

## 5. 验证

```bash
docker compose -f docker-compose.prod.yml ps          # circle_be 应为 healthy
docker compose -f docker-compose.prod.yml logs -f circle_be
# 本机自测(404 也行,说明服务在响应;关键是别 connection refused):
curl -i http://localhost:3000/api/v1/auth/me
```

公网验证:浏览器/另一台机访问 `http://<公网IP>:3000/api/v1/auth/me`。

---

## 排错

- **`npm ci` 报 lockfile 不匹配**:仓库可能只有 `pnpm-lock.yaml` 没有 `package-lock.json`。
  解决:本地 `npm install` 生成 `package-lock.json` 后重新 rsync;或改 Dockerfile.prod 用 pnpm。
- **`argon2` 在 ARM 编译失败**(node:22-slim 缺编译链):在 `Dockerfile.prod` 的 build-stage
  `RUN npm ci` 前加 `RUN apt-get update && apt-get install -y python3 make g++`。
- **migrate 容器报连不上库**:确认 `postgres` healthy;`.env` 的 `DB_PASSWORD` 与
  `.env.production` 的 `DATABASE_URL` 密码一致(gen-env.sh 已保证)。
- **circle_be 启动即退出**:多半是 `.env.production` 缺必填项(SECRET/TEMP_CHAT_LINK_SECRET ≥32、
  ALLOWED_ORIGINS)。看 `docker compose logs circle_be` 的 Joi 校验报错。
- **app 连不上**:确认两层端口都放行(Oracle Security List + iptables)。

---

## 阶段 5 预告:OpenIM(实时聊天)

```bash
git clone https://github.com/openimsdk/openim-docker.git ~/openim-docker
# 编辑 .env 设 OPENIM_IP=<公网IP> 与 secret,然后 docker compose up -d
```
之后把 `OPENIM_API_URL` / `OPENIM_ADMIN_SECRET` / `OPENIM_IM_WS_URL` / `OPENIM_IM_API_URL`
追加进 `.env.production`,重启 circle_be。OpenIM 约吃 4G 内存。

## 阶段 6 预告:LiveKit Cloud(音视频)

注册 livekit.io → 建项目(免费层)→ 拿 `LIVEKIT_URL` / API Key / Secret,
追加进 `.env.production`(含 `LIVEKIT_WEBHOOK_SECRET`、`CALL_ENABLE_VIDEO=true`),重启 circle_be。
无需自托管,音视频不占服务器资源。
