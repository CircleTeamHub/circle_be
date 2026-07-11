# circle_be 部署手册(测试环境 · Oracle ARM)

让测试人员访问全功能后端。一台服务器用 docker-compose 自托管:

| 阶段 | 内容 | 组件 |
|------|------|------|
| 4 | 核心后端 | circle_be + PostgreSQL + Redis + MinIO |
| 5 | 实时聊天 | OpenIM 全套(Mongo/Redis/Kafka) |
| 6 | 音视频 | LiveKit Cloud(免费层,不自托管) |

本文件覆盖**阶段 4**;阶段 5/6 见末尾预告。

---

## 0. 前置

- Oracle Always Free 实例:Ubuntu 22.04 / ARM64 / 2 OCPU / 12 GB
- 已把 `API_DOMAIN`、`ADMIN_DOMAIN` 的 DNS A/AAAA 记录指向服务器公网 IP
- 已能用 `ssh -i ~/.ssh/circle_oracle ubuntu@<公网IP>` 登录

## 1. 安装 Docker(服务器上,一次性)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker version && docker compose version
```

## 2. 放行端口(两层都要开)

**A. Oracle 控制台** → VCN → 对应子网的 Security List → Ingress Rules,加入(Source `0.0.0.0/0`,TCP):
`80`(HTTP/ACME)、`443`(HTTPS API/Admin/MinIO S3)。
> MinIO 控制台(9001)**不对公网开放** —— compose 已把它绑到 `127.0.0.1`,只走 SSH 隧道访问(见 §5)。
> (别用 iptables INPUT 规则去“限制”它:Docker 发布端口走 DOCKER 链、先于 INPUT,挡不住;绑回环才可靠。)

**B. 实例内 iptables**(Oracle 的 Ubuntu 镜像默认只放行 22):

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # 持久化,重启不丢
```

> MinIO S3 不发布宿主机端口；对象下载与签名上传统一通过 API 域名的
> `https://<API_DOMAIN>/circle/*` 路由，避免公网明文传输。

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
bash deploy/gen-env.sh <公网IP> <API域名> <Admin域名> <ACME邮箱>
docker compose -f docker-compose.prod.yml up -d --build
```

启动顺序由 `depends_on` 保证:`postgres` + `redis`(healthy)→ `migrate` + `minio-init`(跑完退出)→ `circle_be`。
首次 `--build` 在 ARM 上约需几分钟。

已有部署可再次运行 `gen-env.sh`:脚本只补齐 Redis 配置,不会覆盖数据库、JWT、MinIO 等现有密钥。
使用托管 Redis 时,把 `.env.production` 的 `REDIS_URL` 改成带认证的 `rediss://...`,
设置 `REDIS_ALLOW_INSECURE=false`,并从 `.env` 的 `COMPOSE_PROFILES` 中移除
`bundled-redis`;此时 Compose 不会启动内置 Redis。

内置 `bundled-redis` 是单节点部署，适合开发、测试和可接受短时降级的单机环境；
它启用 AOF，但主机或数据卷故障仍会造成中断。需要生产级高可用时，使用支持自动故障转移、
跨可用区副本、备份和 TLS 的托管 Redis，并配置 `REDIS_REQUIRED=true`；应用侧的内存限流
只是在 Redis 故障期间保持基础防护，不等价于跨实例一致性或 Redis 高可用。

## 5. 验证

```bash
docker compose -f docker-compose.prod.yml ps          # circle_be 应为 healthy
docker compose -f docker-compose.prod.yml logs -f circle_be
# TLS/反代自测(401/404 也说明服务在响应):
curl -i https://<API域名>/api/v1/auth/me
```

公网验证:浏览器/另一台机访问 `https://<API域名>/api/v1/auth/me`。

MinIO 控制台(只绑服务器本机)从本地开 SSH 隧道访问:

```bash
ssh -i ~/.ssh/circle_oracle -L 9001:localhost:9001 ubuntu@<公网IP>
# 保持连接,浏览器开 http://localhost:9001(账号/密码见 .env 的 MINIO_ROOT_*)
```

---

## 排错

- **`npm ci` 报 lockfile 不匹配**:仓库可能只有 `pnpm-lock.yaml` 没有 `package-lock.json`。
  解决:本地 `npm install` 生成 `package-lock.json` 后重新 rsync;或改 Dockerfile.prod 用 pnpm。
- **`argon2` 在 ARM 编译失败**(node:22-slim 缺编译链):在 `Dockerfile.prod` 的 build-stage
  `RUN npm ci` 前加 `RUN apt-get update && apt-get install -y python3 make g++`。
- **migrate 容器报连不上库**:确认 `postgres` healthy;`.env` 的 `DB_PASSWORD` 与
  `.env.production` 的 `DATABASE_URL` 密码一致(gen-env.sh 已保证)。
- **circle_be 启动即退出**:多半是 `.env.production` 缺必填项(SECRET/TEMP_CHAT_LINK_SECRET ≥32、
  ALLOWED_ORIGINS/REDIS_URL),或 Redis 启动探测失败。先看
  `docker compose logs redis circle_be`;gen-env.sh 会同步生成 Redis 密码和 URL。
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
