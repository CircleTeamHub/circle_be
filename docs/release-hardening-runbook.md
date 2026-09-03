# 发布通道加固部署单(服务器侧)

发布流程已切换到受限 SSH 协议 + 签名清单(v2)。这份单子写清楚服务器上要装的四样东西、
执行顺序、以及装完怎么自检。全程约 20 分钟。

> **在完成这份单子之前,任何 tag 发布都会失败。** 代码已经合并,但服务器上还没有对应的
> ForceCommand、launcher 和签名公钥;现在打 tag,deploy 作业会停在
> `circle-release: command not found`。

对应实现:[`deploy/release-force-command.sh`](../deploy/release-force-command.sh)、
[`deploy/release-launcher.sh`](../deploy/release-launcher.sh)、
[`.github/workflows/release.yml`](../.github/workflows/release.yml)。

---

## 这套东西在防什么

CI 发布时用一把 SSH 私钥登录服务器。这把钥匙一旦泄露,持有者就能以部署账号的身份在那台
机器上执行任意命令 —— 上面跑着生产库、容器和备份。整套加固就是把这把钥匙从「能开 shell」
降级成「只能说两句话」:`circle-release stage-v2` 和 `circle-release activate-v2`。

下面每一处权限位都服务于同一条边界:**部署账号能放东西进来,但不能改动决定「放进来之后
会执行什么」的任何文件。** 否则它随时可以把被执行的脚本换成一个 shell,限制就白设了。

### 权限模型速查

| 路径 | 要求 |
| --- | --- |
| `/usr/local/bin/circle-release-force-command` | root 拥有,部署账号**不可写**。唯一入口。 |
| `~/circle_be/.release/release-launcher.sh` | root 拥有,部署账号**不可写**。脚本会显式拒绝可写的 launcher。 |
| `/etc/circle-release/signing.pub` | root 拥有,部署账号**不可写**。用它验证清单签名。 |
| `~/circle_be/.release/` | 部署账号**必须可写** —— 上传的包要落在这里。 |

最后一条乍看矛盾:目录可写,里面的 launcher 却不可写。原因是上传的发布包必须能落进这个
目录,而 launcher 是「放进来之后会被执行的东西」,可写就等于可以换成任意代码。目录可写
不构成绕过 —— 部署账号被 ForceCommand 限制住,根本没有 shell 去删文件。

---

## 动手之前

- 服务器的 **sudo/root** 权限,以及一个**独立于部署密钥的登录方式**(控制台或你自己的 SSH
  密钥)。第 5 步之前不要关掉它。
- circle_be 仓库 main 分支的一份 checkout(要从里面取两个脚本)。
- GitHub 仓库 Settings 的写权限(要配 secret)。
- 确认部署账号名与部署根目录。默认是 `ubuntu` 与 `~/circle_be`,与 GitHub 变量
  `DEPLOY_USER` 一致。

---

## 执行顺序

步骤是有序的,而且顺序本身有安全含义:**旧密钥必须最后才删**。先删旧钥匙再装限制,一旦
哪一步配错,你就把自己锁在门外了。

### 1. 生成发布签名密钥对(本地)

CI 用私钥给发布清单签名,服务器用公钥验证。私钥只进 GitHub secret,绝不上服务器。

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out release-signing.pem
openssl pkey -in release-signing.pem -pubout -out release-signing.pub

# 私钥内容(整段,含 BEGIN/END 行)稍后贴进 GitHub secret
cat release-signing.pem
```

> 私钥不要留在服务器上,也不要提交进仓库。贴进 GitHub 之后,本地这份请存进密码管理器
> 或直接销毁。

### 2. 安装三个 root 持有的文件(服务器 · root)

`0555` 表示所有人可读可执行、**没有人可写** —— 这正是脚本要求的状态。

```bash
DEPLOY_USER=ubuntu
DEPLOY_ROOT=/home/$DEPLOY_USER/circle_be
REPO=~/circle_be-checkout   # main 分支的 checkout

# 1) ForceCommand 入口
sudo install -o root -g root -m 0555 \
  "$REPO/deploy/release-force-command.sh" \
  /usr/local/bin/circle-release-force-command

# 2) 签名公钥
sudo install -d -o root -g root -m 0755 /etc/circle-release
sudo install -o root -g root -m 0444 \
  release-signing.pub /etc/circle-release/signing.pub

# 3) 状态目录:部署账号可写(要收上传的包)
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 \
  "$DEPLOY_ROOT/.release"

# 4) launcher:root 持有,部署账号只能读和执行
sudo install -o root -g root -m 0555 \
  "$REPO/deploy/release-launcher.sh" \
  "$DEPLOY_ROOT/.release/release-launcher.sh"
```

When these two root-owned files change, upgrade them atomically before enabling
the matching release workflow. The workflow now calls `circle-release capabilities`
before uploading anything, so an old installation fails without touching the live tree.

```bash
sudo install -o root -g root -m 0555 \
  "$REPO/deploy/release-force-command.sh" \
  /usr/local/bin/circle-release-force-command.next
sudo install -o root -g root -m 0555 \
  "$REPO/deploy/release-launcher.sh" \
  "$DEPLOY_ROOT/.release/release-launcher.sh.next"
sudo mv /usr/local/bin/circle-release-force-command.next \
  /usr/local/bin/circle-release-force-command
sudo mv "$DEPLOY_ROOT/.release/release-launcher.sh.next" \
  "$DEPLOY_ROOT/.release/release-launcher.sh"
```

### 3. 配置 GitHub 的密钥与变量

在仓库 *Settings → Secrets and variables → Actions*。`RELEASE_SIGNING_PRIVATE_KEY` 是这次
新增的,建议放进受保护的 `production` 环境而不是仓库级 secret。

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `RELEASE_SIGNING_PRIVATE_KEY` | Secret | 第 1 步的私钥全文 |
| `DEPLOY_SSH_KEY` | Secret | 第 4 步新生成的私钥 |
| `DEPLOY_KNOWN_HOSTS` | Secret | 服务器 host key(`ssh-keyscan` 取) |
| `DEPLOY_HOST` | Variable | 服务器地址 |
| `DEPLOY_USER` | Variable | 部署账号,默认 `ubuntu` |

### 4. 加入新的受限部署密钥(旧的先留着)

`restrict` 会同时关掉端口转发、agent 转发和 pty。ForceCommand 需要**两个参数**:部署根
目录的绝对路径,和签名公钥的路径。

```bash
# 本地生成新的部署密钥对
ssh-keygen -t ed25519 -N '' -C circle-be-release -f deploy_key_new
```

服务器上把公钥按下面的格式追加进 `~/.ssh/authorized_keys`。**整段必须在同一行** ——
被编辑器折行是最常见的失败原因。

```
restrict,command="/usr/local/bin/circle-release-force-command /home/ubuntu/circle_be /etc/circle-release/signing.pub" ssh-ed25519 AAAA...你的公钥... circle-be-release
```

> **此刻不要删旧密钥。** 新旧两把并存,下一步验证通过之后再删 —— 这样配错了还有退路。

### 5. 验证通过后,轮换掉旧密钥

先做完下面的三项自检。全部通过后,才把旧的那把不受限公钥从 `authorized_keys` 里删掉,
并把 GitHub 的 `DEPLOY_SSH_KEY` 换成第 4 步的新私钥。

> **这一步不能省。** 前面所有限制只对新密钥生效;旧的那把只要还在 `authorized_keys` 里,
> 拿到它的人照样能开 shell,整套加固等于没做。

---

## 自检

前两项用**新密钥**执行;第三项用独立的管理员/root 登录直接检查服务器文件。
三项都符合预期,才算装对了。

**一、通用 shell 必须被拒**

```bash
ssh -i deploy_key_new ubuntu@$DEPLOY_HOST "bash -i"
```

预期:`release command rejected: general SSH commands are disabled`

若拿到了 shell 提示符,说明 `command=` 没生效 —— 检查那一行是不是被换行拆开了。

**二、协议入口可达且参数配全**

```bash
ssh -i deploy_key_new ubuntu@$DEPLOY_HOST "circle-release stage-v2"
```

预期:`release command rejected: stage-v2 expects name, manifest, and signature`

这条说明脚本装到位、两个参数都收到了。若看到
`server deploy root or signing public key is not configured`,是 `command=` 里少传了第二个参数。

**三、launcher 必须真实满足执行前置**

用独立的管理员/root 登录服务器执行。部署根目录**必须从 `authorized_keys` 里 `command=`
的第一个参数读出来** —— 那是 ForceCommand 真正使用的根;第 2 步给的 `/home/ubuntu/circle_be`
只是示例值,照抄会在自定义根目录的机器上检查到另一个路径,于是要么无故失败,
要么因为那个路径下碰巧也有个合法 launcher 而通过,真正的发布路径反而没被验证。

```bash
DEPLOY_USER=ubuntu
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"

DEPLOY_ROOT="$(sudo awk -F'"' '
  /circle-release-force-command/ { split($2, parts, " "); print parts[2]; exit }
' "$DEPLOY_HOME/.ssh/authorized_keys")"

test -n "$DEPLOY_ROOT"
launcher="$DEPLOY_ROOT/.release/release-launcher.sh"

sudo test -f "$launcher"
sudo test -x "$launcher"
sudo test ! -L "$launcher"
sudo -u "$DEPLOY_USER" test ! -w "$launcher"
sudo stat -c '%U %G %a %n' "$launcher"
```

`test -n "$DEPLOY_ROOT"` 失败说明 `authorized_keys` 里根本没有那行 ForceCommand,
先回第 2 步。之后四条 `test` 预期没有输出且全部返回 0;`stat` 预期显示 `root root 555`
和 launcher 路径。若任一条失败,回第 2 步重新安装 launcher。

不能用一个不存在的 stage 来验证 launcher:ForceCommand 会先返回 `staged release not found`,
根本还没有执行到 launcher 的存在、符号链接和可写性检查。前两项能进入协议参数校验,
已经同时证明签名公钥存在且部署账号不可写;本项再直接覆盖 launcher 的四个执行前置。

---

## 故障对照

发布失败时,deploy 作业里会出现 `release command rejected: …`。

| 错误信息 | 原因与处理 |
| --- | --- |
| `circle-release: command not found` | ForceCommand 完全没装,SSH 直接执行了字面命令。回第 2 步。 |
| `unknown release protocol command` | 服务器上装的是旧版脚本(只认 `stage`/`activate`)。用 main 的版本覆盖安装。 |
| `server deploy root or signing public key is not configured` | `command=` 里参数不是两个。补上签名公钥路径。 |
| `release signing public key is unavailable` | 公钥路径不存在,或它是个符号链接。 |
| `release signing public key must not be writable by the deployment account` | 公钥能被部署账号改写。改成 root 拥有、`0444`。 |
| `trusted release launcher is unavailable` | `.release/release-launcher.sh` 不存在、不可执行,或是符号链接。 |
| `trusted release launcher must not be writable by the deployment account` | launcher 能被部署账号改写。改成 root 拥有、`0555`。 |
| `release manifest signature verification failed` | 服务器上的公钥与 GitHub 里的私钥不是一对。重做第 1 步并同步两侧。 |
| `release manifest has expired` | 清单签发已超过 1 小时。多半是作业中途长时间等待人工确认;重跑发布即可。 |
| `release manifest is issued in the future` | 服务器与 runner 的时钟相差超过 5 分钟。在服务器上校时(`timedatectl`)。 |
| `unsupported release manifest version` | 脚本与工作流版本不匹配 —— 一侧是 v2 清单、另一侧还认 v1。两侧都用 main。 |
| `deployment home is unavailable` | 部署账号没有可用的 `HOME`。检查该账号的 passwd 条目与家目录是否存在。 |

---

## 协议摘要(改动时对照)

- 只接受 `stage-v2` 与 `activate-v2`,其余一律 `unknown release protocol command`。
- 清单为 **10 行、`version=2`**,含签名的 `issued_at`;有效期 **1 小时**,允许 **5 分钟**
  时钟偏差。`stage` 与 `activate` 两处都校验。
- 归档摘要写在签名清单里,服务器收包后比对;激活参数(schema/tag/image/downtime/
  irreversible)逐项与清单交叉校验。
- 归档上限:257 MiB 传输、256 MiB 实际、10000 个条目、1 GiB 展开、单文件 128 MiB;
  只放行普通文件与目录。

脚本升级后请重跑上面三项自检。
