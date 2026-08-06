# circle_be 部署手册(测试环境 · Oracle ARM)

让测试人员访问全功能后端。一台服务器用 docker-compose 自托管:

| 阶段 | 内容 | 组件 |
|------|------|------|
| 4 | 核心后端 | circle_be + PostgreSQL + Redis + MinIO |
| 5 | 实时聊天 | 自研 chat(随 circle_be 同进程,/chat-ws;无额外组件) |
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
  deploy   暂存仓库 → 持久 launcher 锁定检查/激活/执行(见下)→ runner 外部烟测
  publish  自动生成 changelog 的 GitHub Release(仅 tag push)
  notify   Discord 通知,成功失败都发(if: always())
```

要点:**部署的镜像就是 main 上完成阻断式 ARM64 扫描的 digest**(发布不重新构建;
PR/main CI 的独立镜像扫描提供更早反馈，ARM64 workflow 再扫描实际发布产物);
构建发生在 merge 时,发版本身通常 2–3 分钟。

### 服务器上:蓝绿切换,失败自动回滚

`.release/release-launcher.sh` 先取得 rsync 树外的持久锁,重新读取 schema 兼容下限,
再把已暂存的发布树原子激活并调用 `deploy/release-deploy.sh`。目标脚本的顺序:

```
flock 单飞锁 → 拉镜像 → pg_dump 备份(保留 7 份,~/circle_be_backups/)
             → 加密后上传一份到主机之外(可选,见「异地备份」;未配置则跳过)
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

**不可逆迁移**:仓库存在 `deploy/REQUIRES_IRREVERSIBLE_MIGRATION` 时,tag push 会
fail closed,不会连接服务器。必须从 Actions 手动运行 Release,同时勾选
`downtime: true` 和 `irreversible_migration: true`。服务器也会二次校验
`RELEASE_IRREVERSIBLE_MIGRATION=1` 必须与 `RELEASE_DOWNTIME=1` 同时启用。

不可逆迁移命令返回非零时,脚本会通过发布镜像连接目标数据库,直接检查 User、Circle
和 CirclePost 的四个会员等级约束。只有四个约束都不存在时,才能证明事务未应用并恢复
旧实例;四个都存在、只存在一部分、探测失败或返回异常结果
都会保持维护状态。迁移命令成功后,旧二进制同样不再是合法回滚目标;后续启动、
健康、代理、状态写入或烟测失败都会等待向前修复。只有先从本次迁移前备份完整恢复
数据库,才能再启动旧镜像。

兼容级别来自 tag 内的 `deploy/SCHEMA_COMPATIBILITY`。不可逆迁移开始前,服务器会把
最低级别原子写入 rsync 排除的 `.release/minimum-schema-compatibility`;持久 launcher
在同一把锁内重新读取它、激活目标树并等待目标脚本退出,所以并发的旧 tag 会在替换
服务器脚本和启动容器前被拒绝。该文件不是
普通回滚开关:只有完整恢复迁移前数据库、验证上述四个约束均不存在后,值班人员才可
显式删除它,再运行旧 tag。
本次会员迁移的完整值班步骤和验证 SQL 见
`docs/operations/membership-rollout.md`。标记只能由**后续已成功部署**、且不再包含
不可逆迁移的版本移除,不能在会员迁移 tag 上提前删除。

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
- **服务器上手动**(GitHub 不可用时):将目标 tag 检出到 live tree 之外,按 workflow
  的排除规则暂存到 `~/circle_be/.release/incoming/<唯一名称>/`,然后通过持久 launcher
  激活。不要直接执行目标树内的 `deploy/release-deploy.sh`。

  ```bash
  cd ~/circle_be
  stage=manual-v0.1.0-$(date +%s)
  mkdir -p ".release/incoming/$stage"
  rsync -a --delete --exclude=/.release --exclude=/.env --exclude=/.env.production \
    --exclude=.git --exclude=node_modules --exclude=dist --exclude=logs \
    /path/to/external-v0.1.0-checkout/ ".release/incoming/$stage/"
  TARGET_SCHEMA_COMPATIBILITY=$(cat ".release/incoming/$stage/deploy/SCHEMA_COMPATIBILITY" 2>/dev/null || printf 0) \
  RELEASE_TAG=v0.1.0 \
  CIRCLE_BE_IMAGE=ghcr.io/circleteamhub/circle_be@sha256:<64位digest> \
    bash .release/release-launcher.sh "$stage"
  ```

  携带不可逆迁移标记的版本还必须增加
  `RELEASE_DOWNTIME=1 RELEASE_IRREVERSIBLE_MIGRATION=1`;缺一项脚本都会在备份和
  迁移前拒绝运行。越过迁移成功边界后,不要直接改用旧 tag 重跑;先向前修复,或先
  恢复迁移前数据库备份并验证四个约束均不存在,然后显式删除
  `.release/minimum-schema-compatibility`。

  镜像还在本地缓存时无需登录;缓存已清且仓库私有,先用带 `read:packages` 的
  PAT `docker login ghcr.io` 再跑。
- **数据库**:迁移前备份在 `~/circle_be_backups/`,恢复:
  `gunzip -c <备份文件> | docker compose -f docker-compose.prod.yml exec -T postgres psql -U circle -d circle`。
  这台服务器本身已经没了(磁盘损坏 / 实例丢失 / 主机被入侵)时,本地备份也一起没了 ——
  改从异地副本恢复,见下面「异地备份」。

### ⚠️ 加固待办:锁死历史 workflow 绕过 floor(需服务器端配置)

> 本项目尚未上线,此项当前不触发;上线前须逐条复评 —— 见
> [docs/pre-launch-checklist.md](docs/pre-launch-checklist.md)。

**残留风险(未闭合)**:`.release/release-launcher.sh` 的持久锁 + `minimum-schema-compatibility`
下限,以及 `release-deploy.sh` 顶部的 `RELEASE_LAUNCHER_ACTIVE` 守卫,都只保护**当前**发版
管线。若有人重跑一个**在 launcher 引入之前**的旧 Release workflow,它会把自己的检出用 rsync
直接盖到 `DEPLOY_PATH` 并执行**那份旧的、无守卫的** `release-deploy.sh` —— 既不经过持久
launcher、也不读 `minimum-schema-compatibility`,于是可能在已抬高 floor 之后仍启动旧二进制、
打到已被不可逆迁移契约化的 schema 上。

**为什么仓库内改不掉**:旧 workflow 发给服务器的命令(`rsync … DEPLOY_PATH/` + `bash
deploy/release-deploy.sh`)由**旧的检出**决定,新代码无法改变历史 workflow 会发什么。唯一
能拦截它的层是**服务器的 `~/.ssh/authorized_keys`**,不在本仓库里。

**目标修法(SSH ForceCommand)**:给部署 key 挂 `command="…"`,把该 key 的所有 SSH 会话
强制经过 `.release/` 下的持久入口 —— 只放行「rsync 进 `.release/incoming/`」「安装 / 调用
launcher」,拒绝「live-tree rsync」和「直接执行 `release-deploy.sh`」。因为 `command=` 写在
服务器 authorized_keys 里,任何被 rsync 覆盖的仓库代码都替换不了它,历史 workflow 也就绕
不过去。

**为何尚未落地**:`.github/workflows/release.yml` 现用 `bash -s`(经 stdin 传 GHCR token,
刻意不进 `argv` 以免出现在 `ps`)。ForceCommand 无法内省 stdin 脚本,所以启用它必须同时把
发版流改成**显式命令**且保持 token 不进 argv —— 属较大、需在 **staging 真跑一次**验证的独立
运维改动,不在应用代码 PR 范围内。

**在此之前的运维硬约束**:① 绝不重跑「抬高 floor 之前」的历史 Release workflow;② 回滚一律
走上面〈回滚 / 重放〉的持久 launcher 手动流程,绝不直接执行目标树内的 `release-deploy.sh`。

### ⚠️ 加固待办:不可逆重放的空跑不应封死可兼容活色(需 staging 验证)

> 本项目尚未上线,此项当前不触发;上线前须逐条复评 —— 见
> [docs/pre-launch-checklist.md](docs/pre-launch-checklist.md)。

**现象**:重发一个**已成功上线**的不可逆 tag 且用 downtime 模式时,`release-deploy.sh` 先停活色 →
`prisma migrate deploy` 空跑成功 → 无条件置 `irreversible_migration_applied=1`。若此时新色(备色)
启动/健康检查失败,`irreversible_boundary_crossed` 为真 → 进 `enter_irreversible_maintenance`,
**拒绝恢复活色**——可活色是**同一个 tag、schema 本就兼容**,本可安全恢复,却把一次可恢复的重放
失败变成了持续维护态。

**目标修法**:为每个成功上线的颜色持久化其 schema 兼容级别(如 `.release/<color>-schema`),备色失败
时若**活色已支持当前 schema**(其兼容级别 ≥ 本次 `RELEASE_SCHEMA_COMPATIBILITY`)则允许恢复活色,
而非一律进维护。

**为何暂不改**:这段是不可逆迁移的**回滚安全闸**——判断错(把不兼容的旧二进制恢复到已契约化的
schema 上)不是可用性抖动,而是数据损坏级事故。改动本地无法对真实蓝绿 + 迁移状态机验证,必须在
**staging 真跑**(含备色失败注入)后再合。**在此之前的运维约束**:重发已上线的不可逆 tag 前,确认
备色能起;若备色失败进了维护态,手工确认活色 tag 与 DB schema 一致后再恢复,不要盲目清状态文件。

### 异地备份(可选;加密后上传到对象存储)

`~/circle_be_backups/` 和 `pg_data` 卷在**同一台 VPS** 上:磁盘损坏、实例丢失、
主机被入侵会把数据和备份一起带走。开启本功能后,每次发版的 pg_dump 会额外加密
上传一份到主机之外。本地备份的顺序、命名、7 份保留策略都**不受影响** —— 它仍然
是迁移安全网。

**不开启 = 行为完全不变**:没有 `~/.circle_be_backup.env` 时脚本不做任何事、
不打印、不报错。现有部署不需要改动。

#### 加密:age 公钥模式(不是 gpg --symmetric)

理由只有一条,但是决定性的:**服务器上只放公钥**。对称加密要求加密方持有解密
口令,主机被入侵时攻击者能连备份一起解密 —— 异地副本的意义当场归零。公钥模式
下这台机器只能"写进去",永远解不开自己送出去的东西。

脚本会拒绝 `AGE-SECRET-KEY-` 开头的值,挡住"把私钥误配到服务器上"这个最危险的
操作失误。

#### ⚠️ 密钥丢失 = 所有异地备份永久报废

这是本方案最大的单点。**私钥丢了,桶里那些文件就是一堆无法恢复的随机字节** ——
比没有备份更糟,因为它让人误以为有备份。所以:

1. 生成**两把**密钥,一把日常、一把 break-glass:

   ```bash
   age-keygen -o circle-backup-primary.key      # 输出里的 age1... 就是公钥
   age-keygen -o circle-backup-breakglass.key
   ```

2. `BACKUP_OFFSITE_AGE_RECIPIENTS` 填**两个公钥**(空格分隔)。age 会给每个
   收件人各封装一次密钥,**任一把私钥都能独立解密**,不需要凑齐。
3. 私钥去处(**绝不留在服务器上,绝不进 git,绝不进聊天软件**):
   - primary:密码管理器(1Password / Bitwarden 的 secure note);
   - break-glass:离线介质或纸质打印件,和 primary **不同物理位置**。
4. 分发完把服务器/工作机上的私钥文件抹掉:`shred -u circle-backup-*.key`。
5. 每次轮换密钥后,**必须**按下面「恢复演练」实跑一遍再认为它有效。

#### 目标桶:必须用独立的只写凭证

**不要复用应用自己的 `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`。** 整件事的前提
是:这台机器被入侵时,攻击者**删不掉**备份 —— 这正是勒索软件的标准路径。要求:

- 桶**开启版本控制**(object versioning);
- 上传凭证只有 `s3:PutObject`,**没有** Delete / Get / List;
- 恢复用的读凭证**另外一把**,只在恢复时从密码管理器取出,**不放服务器**。

服务器上这把只写凭证的策略(AWS S3 / MinIO,把 `__BUCKET__` 换成桶名):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupWriteOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": ["arn:aws:s3:::__BUCKET__/*"]
    }
  ]
}
```

恢复用的读凭证策略(**只存密码管理器**):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupRestoreRead",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": ["arn:aws:s3:::__BUCKET__/*"]
    },
    {
      "Sid": "BackupRestoreList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::__BUCKET__"]
    }
  ]
}
```

上面这套只写策略实测可用:`aws s3 cp` 上传单个对象只需要 `s3:PutObject`,
同一把凭证做 delete / get / list 会被拒(见本仓库 PR 里的往返验证输出)。

各家的差异,**别踩坑**:

- **AWS S3** —— 策略直接可用。再开 Versioning;要更强可加 Object Lock
  (compliance 模式),那样连 root 都删不掉未过期的版本。
- **Backblaze B2** —— application key 可以只勾 `writeFiles` 而不给
  `deleteFiles` / `readFiles`,是真正的只写,且支持 Object Lock。
- **Cloudflare R2** —— API token 权限档位偏粗:最窄的能 PutObject 的档位是
  "Object Read & Write",**同时带读和删**。R2 因此拿不到严格的只写语义,
  "入侵者删不掉备份"这条性质在 R2 上**不成立**。只图便宜/出网方便可以用 R2,
  但要这条性质就选 S3 或 B2。

#### 开通步骤

服务器上:

```bash
sudo apt-get install -y age awscli          # Ubuntu 22.04 两个都在源里
cp deploy/backup.env.example ~/.circle_be_backup.env
chmod 600 ~/.circle_be_backup.env
# 编辑它,把 __XXX__ 占位换成:桶名、endpoint、只写凭证、age 公钥
```

apt 装的是 aws-cli v1(22.04 上是 1.22.34),已实测可用;官方安装器的 v2 也可以。
配了非 AWS endpoint 时脚本会自动设 `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`
—— v2.23+ 默认发的 CRC trailer 会被 R2 和旧版 MinIO 拒绝,v1 忽略该变量,两边都不用管。

配置文件**必须放在 `$HOME`,不能放进仓库目录** —— 发版的 `rsync --delete`
会删掉仓库里的陌生文件,`$HOME` 不在同步范围内。脚本只做 `KEY=VALUE` 解析,
不 source,配置文件里的内容不会被当成代码执行。

下一次发版的日志里应该出现:

```
==> Shipping encrypted backup to s3://<bucket>/circle_be/circle-<ts>-pre-<tag>.sql.gz.age
==> Off-host backup uploaded: s3://<bucket>/circle_be/circle-<ts>-pre-<tag>.sql.gz.age
```

#### 上传失败:发版继续,但会大声报错

设计取舍:**上传失败不阻断发版**。走到这一步本地 pg_dump 已经成功,这次发版真正
需要的安全网(迁移改坏数据能回滚)已经就位。异地副本防的是"整台 VPS 没了",
那件事和这次发版不相关 —— 拦下发版不会让它更安全,只会把一次紧急修复推迟到
云存储恢复之后。

代价是可能静默烂掉,所以失败时会同时做三件事:

- stderr 打一整块 `OFF-HOST BACKUP UPLOAD FAILED` 横幅;
- stdout 写一行 GitHub Actions annotation,在 run 摘要页显示红色告警
  (**不会**让 job 变红,job 状态只看退出码);
- 写状态文件 `~/circle_be_backups/.offsite-status`。

例行检查(建议进值班清单):

```bash
cat ~/circle_be_backups/.offsite-status
# ok 2026-07-18T09:12:44Z s3://circle-backups/circle_be/circle-...sql.gz.age
# 或 failed <时间> <原因>
```

配置错误(没填公钥、没装 age、凭证缺失)同样只告警不中断,并且**绝不会**退化成
上传明文 —— 没有可用公钥时脚本直接拒绝上传。

#### 恢复演练 / 真正的恢复

**没恢复过的备份只是一个假设。** 至少每季度、以及每次轮换密钥后跑一遍。
在**工作机**上做(服务器上既没有读凭证也没有私钥,本来就做不了):

```bash
export AWS_ACCESS_KEY_ID=<恢复用只读凭证>
export AWS_SECRET_ACCESS_KEY=<...>
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required   # R2 / MinIO 必需

S3="aws --endpoint-url https://<account>.r2.cloudflarestorage.com --region auto"
# 用 AWS S3 时去掉 --endpoint-url,--region 换成桶所在 region

# 1. 列出可用备份
$S3 s3 ls s3://<bucket>/circle_be/

# 2. 下载
$S3 s3 cp s3://<bucket>/circle_be/circle-<ts>-pre-<tag>.sql.gz.age ./

# 3. 解密(私钥从密码管理器取出,用完删掉)
age -d -i circle-backup-primary.key \
    -o circle-<ts>.sql.gz circle-<ts>-pre-<tag>.sql.gz.age

# 4. 演练:灌进一次性的本地库,不要碰生产
docker run -d --name pg-drill \
  -e POSTGRES_USER=circle -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=circle postgres:16
sleep 5
gunzip -c circle-<ts>.sql.gz | docker exec -i pg-drill psql -U circle -d circle
docker exec -i pg-drill psql -U circle -d circle -c '\dt'          # 表都在?
docker exec -i pg-drill psql -U circle -d circle -c 'SELECT count(*) FROM users;'
docker rm -f pg-drill
```

真要恢复生产库时,把第 4 步换成本节上面「回滚 / 重放」里的那条命令:

```bash
gunzip -c circle-<ts>.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U circle -d circle
```

> 只写凭证**读不了**桶,所以脚本无法在上传后回读校验。"上传成功"只代表
> PutObject 返回 200。真正的验证只能靠上面这个演练 —— 请当成必做项。

#### 主机被入侵后的恢复:不要直接取最新版本

只写凭证删不掉对象,但**能覆盖**它。所以入侵者虽然毁不掉历史,却可以把
**最新版本**换成垃圾。开了版本控制的意义正在于此 —— 恢复时要按版本取:

```bash
# 列出该对象的所有版本(IsLatest=False 的才是被覆盖前的)
$S3 s3api list-object-versions --bucket <bucket> \
    --prefix circle_be/circle-<ts>-pre-<tag>.sql.gz.age \
    --query 'Versions[].{Ver:VersionId,Latest:IsLatest,Size:Size,When:LastModified}' --output table

# 按 VersionId 取回某个具体版本
$S3 s3api get-object --bucket <bucket> \
    --key circle_be/circle-<ts>-pre-<tag>.sql.gz.age \
    --version-id <VersionId> ./recovered.sql.gz.age
```

判断依据:被覆盖的垃圾版本通常尺寸明显异常(几十字节),且 `age -d` 会直接
解密失败。取最近一个能正常解密、尺寸合理的版本。

> 因此**桶的生命周期规则不能删除 noncurrent 版本**,至少保留到你的恢复窗口
> (建议 ≥30 天)。否则入侵者只要覆盖足够多次,历史版本就会被规则自动清掉。

#### 这套方案**不**覆盖什么

别把它当成完整的灾难恢复。明确**不在**范围内:

| 没覆盖 | 后果 |
|---|---|
| **RPO = 一次发版** | 备份只在发版时产生。两次发版之间(可能几天到几周)写入的数据,VPS 挂掉就没了。要更小的 RPO 得另做定时备份或 WAL 归档(pgBackRest / WAL-G)。 |
| **MinIO 对象** | 头像、图片、附件全在 `minio_data` 卷里,**完全没有异地副本**。只恢复数据库的话,这些引用会变成坏链。 |
| **聊天记录** | 自研 chat 存业务 PostgreSQL,随数据库备份一并覆盖(旧 OpenIM Mongo 栈退役)。 |
| **Redis** | 内置 Redis 只做缓存/限流,故意不备份。 |
| **自动恢复验证** | 没有任何自动化在验证备份可用。上面的演练要人去跑。 |

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

## 阶段 5:实时聊天(自研 chat,无需独立部署)

聊天栈已并入 circle_be 本体(socket.io 网关挂在同一 HTTP 端口的 `/chat-ws`,
数据存业务 PostgreSQL 三表),**没有独立的聊天组件要部署**;Caddy 的 API 域
catch-all 反代已覆盖 WS 升级。旧 OpenIM(openim-docker,约 4G 内存)退役:

```bash
cd ~/openim-docker && docker compose down   # 确认新栈跑通后再执行;卷按需清理
```

敏感词拦截为进程内检查(`CHAT_SENSITIVE_WORD_BLOCKED`),无需 webhook 配置;
词库仍用 `POST /api/v1/admin/sensitive-words/add` 管理(admin JWT,单批 ≤1000,
空词库 = 全放行,改动 ≤60s 内收敛)。

## 阶段 6 预告:LiveKit Cloud(音视频)

注册 livekit.io → 建项目(免费层)→ 拿 `LIVEKIT_URL` / API Key / Secret,
追加进 `.env.production`(含 `LIVEKIT_WEBHOOK_SECRET`、`CALL_ENABLE_VIDEO=true`),重启 circle_be。
无需自托管,音视频不占服务器资源。

---

## 阶段 7:持续备份(**上线前必做**)

`pg_data`、`minio_data` 都是同一台机器上的 docker volume(自研 chat 后聊天记录
就在 `pg_data` 里)。一次 `docker compose down -v`、一块坏盘,业务数据和聊天记录会
**同时**全部消失,且没有任何第二份副本。

> **和上面「异地备份」的区别 —— 两者都要,不是二选一。**
> 上面那节(`deploy/offsite-backup.sh`)只在**发版时**打一份 pg_dump 快照传到异地,
> 保护的是「这次迁移把库改坏了」,而且**只覆盖 Postgres**。
> 本节是**持续**备份:WAL 连续归档(Postgres RPO ≈ 60–90 秒,已含聊天记录)、
> 对象每 15 分钟镜像,保护的是「机器没了」。发版之间的写入、用户上传的媒体、
> 所有聊天消息,只有本节覆盖得到。

完整方案(覆盖范围、RPO/RTO、运维必须自行创建的桶和凭证、恢复演练、灾难恢复流程)
见 **[docs/backups.md](docs/backups.md)**。

```bash
cp .env.backup.example .env.backup && chmod 600 .env.backup   # 填好再启用
docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml up -d
```

> 遗留:`openim-backup` profile(OpenIM Mongo 每小时加密 dump)仅在退役前的旧栈
> 迁移期有用 —— 新聊天数据全在 Postgres,不再需要它;旧栈 down 掉后请勿启用该 profile。

> 注意:备份是**可选 overlay**。不叠加 `docker-compose.backup.yml` 时基础栈行为完全不变;
> 但反过来,叠加启用后若某次只用 `-f docker-compose.prod.yml up -d`,postgres 会被按基础
> 定义重建,**WAL 归档会被静默关掉**。docs/backups.md 里有 `COMPOSE_FILE` 的固定方法,
> 且 `check.sh` 每小时会检测这种情况。

启用后务必跑一次恢复演练 —— 没演练过的备份不算备份:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml \
  run --rm backup run drill
```
