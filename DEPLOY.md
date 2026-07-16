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
# TLS/反代自测(该已知路由应返回 2xx/3xx/401/403，404 表示路由故障):
curl -i https://<API域名>/api/v1/auth/me
```

探针(不需要认证,不走 `api/v1` 前缀,也不受限流影响):

- `GET /healthz` —— 存活:进程还在就返回 200,不查任何依赖。公网可访问,供外部
  uptime 监控使用。
- `GET /readyz` —— 就绪:真查数据库(`SELECT 1`),连不上返回 503;Redis 状态只
  上报不拦截(Redis 可选,故障时降级为单实例限流/实时)。compose 的 healthcheck
  探的就是它,因此 `circle_be` 显示 healthy 才代表真的能服务。Caddy 对公网 404
  它,只能在容器内查:

```bash
docker compose -f docker-compose.prod.yml exec circle_be \
  node -e "require('http').get('http://127.0.0.1:3000/readyz',r=>r.pipe(process.stdout))"
# {"status":"ok","database":"up","redis":"up"}
```

公网验证:浏览器/另一台机访问 `https://<API域名>/api/v1/auth/me`。

MinIO 控制台(只绑服务器本机)从本地开 SSH 隧道访问:

```bash
ssh -i ~/.ssh/circle_oracle -L 9001:localhost:9001 ubuntu@<公网IP>
# 保持连接,浏览器开 http://localhost:9001(账号/密码见 .env 的 MINIO_ROOT_*)
```

---

## 6. 自动发版(build-once-promote + 蓝绿零停机)

手动流程(§3–§4)保留给**首次开通/基础设施变更**;日常升级 circle_be 只需:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

### 架构:构建一次,发布只"盖章"

```
push main ──► build-image.yml:QEMU 交叉构建 linux/arm64
                └─► 阻断式 Trivy 扫描该 ARM64 镜像
                    └─► 通过后才 push sha-<commit>(+ :main)

push tag v* ──► release.yml:
  resolve  校验 tag 在 main 历史上、该 commit 的 CI 是绿的、找 sha- 镜像
  缺失 sha- 镜像时立即失败，不在发版时重新构建
  promote  buildx imagetools create:把 sha- 镜像原样打上 v* 版本 tag(秒级)
  deploy   rsync 仓库 → SSH 执行 deploy/release-deploy.sh(见下)→ runner 外部烟测
  publish  自动生成 changelog 的 GitHub Release(仅 tag push)
  notify   Discord 通知,成功失败都发(if: always())
```

要点:**部署的镜像就是 main 上完成阻断式 ARM64 扫描的 digest**(发布不重新构建;
PR/main CI 的独立镜像扫描提供更早反馈，ARM64 workflow 再扫描实际发布产物);
构建发生在 merge 时,发版本身通常 2–3 分钟。

### 服务器上:蓝绿切换,失败自动回滚

`deploy/release-deploy.sh` 的顺序:

```
flock 单飞锁 → 拉镜像 → pg_dump 备份(保留 7 份,~/circle_be_backups/)
→ prisma migrate deploy(用发布镜像跑)
→ 起另一色容器(circle_be / circle_be_green 交替)
→ 容器健康门禁(300s)→ validate 并原子 reload Caddy 到新色的唯一容器端点
  (`circle-be-blue` / `circle-be-green`)→ 走公网域名烟测
→ 通过:停/删旧色,完成;失败:代理切回旧色并清理新色,CI 标红
```

Caddy 通过 `CIRCLE_BE_UPSTREAM` 明确选择在役颜色，并把选择原子写入
`.release/active-color`；中断重跑时会先恢复记录的颜色，不会猜测。每次切换先
`caddy validate`，再 `caddy reload`，任一步失败都会保留或恢复旧实例。
公网 API 烟测固定请求 `/api/v1/auth/me`，只接受 `401/403` 且 `Content-Type`
为 JSON，SPA 的 `200 text/html` 不会被误判为成功。
两色交接期间请求不会落到 502 —— 正常发版**零停机**。
postgres/redis/minio/caddy/admin_web 属于开通期资产,发版**不碰**;
`.env` / `.env.production` 被 rsync 排除并保护,不会被发版覆盖或删除。

**迁移兼容性要求**:蓝绿窗口内旧代码会短暂运行在新 schema 上,迁移必须向后兼容
(expand/contract:先加列/表,删除留到后续版本)。确实不兼容时,手动触发 workflow
勾选 `downtime: true`(先停旧版本再迁移,接受短暂停机;此模式下若失败,
回滚可能还需恢复迁移前备份)。

### 一次性配置(GitHub 仓库 Settings → Secrets and variables → Actions)

| 类型 | 名称 | 值 |
|---|---|---|
| Secret | `DEPLOY_SSH_KEY` | 部署私钥全文(建议单独生成一把只授权这台服务器的,不复用个人钥) |
| Secret | `DEPLOY_KNOWN_HOSTS` | **必填**；从可信网络预先核验并保存服务器 host key，workflow 不做 TOFU/keyscan |
| Secret | `DISCORD_WEBHOOK_URL` | 已有,CI 复用同一个 |
| Variable | `DEPLOY_HOST` | 服务器公网 IP 或域名 |
| Variable | `DEPLOY_USER` | 可选,默认 `ubuntu` |
| Variable | `DEPLOY_PATH` | 可选,默认 `circle_be`(相对远端 $HOME) |
| Variable | `API_SMOKE_URL` | 可选，必须指向无需凭据时返回 `401/403` JSON 的已知 API 路由，如 `https://<API域名>/api/v1/auth/me`；设了则 runner 侧再做一次外部视角烟测 |

镜像推/拉全用内置 `GITHUB_TOKEN`,无需额外 PAT;服务器只在部署那一刻用临时 token
登录 GHCR(隔离的 DOCKER_CONFIG,用完即删),镜像随后留在本地 Docker 缓存,
重启和回滚不依赖注册表。

### 回滚 / 重放

- **一键回滚**:Actions → Release → Run workflow,填旧 tag(如 `v0.1.0`)。
  走同一条管线:镜像已存在 → 秒级 promote → 蓝绿切换。tag 太老、
  CI run 已过期(90 天)时勾 `force` 跳过绿灯校验。
- **服务器上手动**(GitHub 不可用时):

  ```bash
  cd ~/circle_be
  RELEASE_TAG=v0.1.0 \
  CIRCLE_BE_IMAGE=ghcr.io/circleteamhub/circle_be@sha256:<64位digest> \
    bash deploy/release-deploy.sh
  ```

  镜像还在本地缓存时无需登录;缓存已清且仓库私有,先用带 `read:packages` 的
  PAT `docker login ghcr.io` 再跑。
- **数据库**:迁移前备份在 `~/circle_be_backups/`,恢复:
  `gunzip -c <备份文件> | docker compose -f docker-compose.prod.yml exec -T postgres psql -U circle -d circle`。

### 关联发版:admin_web(管理端)与 App(安卓)

- **admin_web**:主分支 workflow 测试并构建 `sha-<commit>` 的 arm64 镜像；tag
  workflow 只提升已构建 manifest、解析 digest，再通过 SSH 执行本仓库的
  `deploy/admin-web-deploy.sh`
  (overlay `docker-compose.admin-release.yml`,只动 admin_web 一个服务,
  与 circle_be 发版共用互斥锁)。它需要的 secrets/vars 与上表相同 ——
  建议配成 **组织级** secrets,两个仓库共用。
  **顺序要求**:先部署本仓库变更，让 Caddy 接管管理域名的 `/api/*` 并根据
  `CIRCLE_BE_UPSTREAM` 直连当前在役颜色的唯一容器端点，再发布只提供静态文件的
  admin_web 镜像。
- **App(风信,Expo/RN)**:workflow 在 `Circle_frontend` 仓库
  (`release-android.yml`,tag `v*` 触发):全量质量门禁 → 用正式 keystore 构建
  release APK(版本号取自 tag)→ 挂到 GitHub Release + Discord 通知。
  iOS 暂无(仓库没有 ios/ 工程,需 Apple Developer 账号后再加)。
  App 不部署到这台服务器,只产出安装包。

### 其他

- **人工闸门**:deploy job 挂在 `production` environment 上;要"人工确认才上线",
  在 Settings → Environments → production 加 required reviewers 即可,不用改 workflow。
- **镜像清理**:cleanup-images.yml 每周一自动清理老的 `sha-*` 镜像
  (保留最新 20 个且 14 天内的不动);`v*` 发布镜像与 `main` 永久保留。
  服务器本地的旧镜像可偶尔 `docker image prune -a --filter "until=720h"`(慎用)。
- **构建时长**:amd64 runner 经 QEMU 交叉构建 arm64,首次 ~15–25 分钟,有 GHA 缓存后明显变快;
  构建在 main push 时异步发生,不占发版时间。仓库转 public 后可把两个构建 job 的
  `runs-on` 改成 `ubuntu-24.04-arm` 原生构建并删掉 QEMU 步骤(私有仓库的 ARM runner 收费)。
- **SSH 加固(可选)**:服务器 `authorized_keys` 里可给部署公钥加
  `no-port-forwarding,no-agent-forwarding,no-X11-forwarding` 等限制,收窄这把钥匙的能力。
- **转入自动发版后的日常运维**:改动基础设施(如 caddy/minio 配置)时,
  只 up 对应服务(`docker compose -f docker-compose.prod.yml up -d caddy`),
  不要裸跑整栈 `up -d`——那会按 build 路径把停用的那一色重新拉起来。
- **首次自动发版**:会把手动 `--build` 的旧容器无缝换成 GHCR 镜像(蓝→绿切换),数据卷不动。

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
- **circle_be 一直 unhealthy**:healthcheck 探 `/readyz`,只认 2xx —— 容器在跑但数据库
  连不上就是 unhealthy(这是预期行为)。按 §5 在容器内 curl `/readyz` 看 `database`
  字段,并查 `docker compose logs postgres circle_be`。
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
