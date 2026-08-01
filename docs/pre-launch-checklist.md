# 上线前 checklist

本项目至今**未上线**：没有生产环境、没有真实用户数据。多条 review 发现的风险前提是
「生产已有存量数据」或「有在跑的旧二进制」，在当前阶段**不触发**，因而被推迟；但它们会在
**首次上线时同时生效**。本文档是这些推迟项的单一入口，上线前逐条复评。

> 定级说明:下面的「当前」指未上线阶段,「上线后」指有真实用户数据与生产部署之后。
> 三条都不是可以静默带过的历史包袱 —— 它们只是**还没到触发条件**。

---

## 1. program disabled 时,营销 floor 会连带施加 gold 数值配额

**当前**:无影响(零用户)。**上线后**:P1 —— 会在「部署完成 → 正式启用会员」的窗口期误伤重度用户。

### 现象

[`membership-policy.service.ts`](../src/membership/membership-policy.service.ts) 的
`resolveEntitlementWith` 在会员计划**未启用**时,把所有用户抬到 `MARKETING_ENTITLEMENT_FLOOR_LEVEL = 2`(gold):

```ts
const level = program.enabled
  ? actual.level
  : Math.max(actual.level, MARKETING_ENTITLEMENT_FLOOR_LEVEL);
```

这个 floor 的**本意是授予**:program 未启用时不该把功能锁在会员墙后 —— 例如
[`circle.service.ts`](../src/circle/circle.service.ts) 中「有效档 0(普通/已过期)不能建圈」,
若不抬 floor,未启用阶段所有人都建不了圈。

问题在于 `level → tier → 配额` 是**同一次查表**([`membership.catalog.ts`](../src/membership/membership.catalog.ts)),
所以抬到 gold 的同时也套上了 gold 的**数值上限**:

| 配额 | gold(即未启用时的实际上限) |
|------|------------------------------|
| `groupMembers` | 400 |
| `joinedCircles` | 300 |
| `notes` | 500 |
| `cityFilters` | 10 |

返回的这个 level 会流向所有强制拦截路径,由各自的端点抛**不同**的错误码。注意
`assertQuotaAvailable`(会抛 `MEMBERSHIP_QUOTA_REACHED`)**在生产代码中没有任何调用方**,
只被单测引用 —— 按它做灰度校验、看板或客户端断言会漏掉全部真实拒绝:

| 拦截路径 | 抛出位置 | 错误码 |
|----------|----------|--------|
| 建圈上限 | `circle.service.ts`(`CIRCLE_CREATE_LIMIT`) | `CIRCLE_CREATE_LIMIT_REACHED` |
| 入圈上限 · 本人申请 | `circle-admission-policy.ts`(`throwJoinLimitReached('self')`) | `CIRCLE_JOIN_LIMIT_REACHED` |
| 入圈上限 · 邀请 / 审批他人 | `circle-admission-policy.ts`(`throwJoinLimitReached('third-party')`) | `CIRCLE_TARGET_JOIN_LIMIT_REACHED` |
| 建圈时申报的容量 | `circle.service.ts:141` | `MEMBERSHIP_GROUP_MEMBER_CAPACITY_EXCEEDED` |
| 圈子成员容量 | `circle-admission-policy.ts:179,248` | `CIRCLE_MEMBER_LIMIT` |
| 广场城市筛选 | `circle-plaza.service.ts:486` | `CITY_FILTER_QUOTA_REACHED` |
| 笔记存储 | `note.service.ts:400`(`assertNoteStorageAvailable`) | `NOTE_STORAGE_QUOTA_REACHED` |

建圈上限与会员档位无关，所有档位最多建 20 个，定义在 `circle/circle-limits.ts`。入圈上限
读取 `MEMBERSHIP_CATALOG[*].quotas.joinedCircles`：普通用户 100，Silver 200，Gold 300，
Diamond 1000，Super 2000；只统计 ACTIVE 且非 OWNER 的成员关系。

其中「建圈时申报的容量」容易被漏掉:`CircleService.create` 校验的是**请求里申报的
`maxMembers`**(`maxMembers > quotas.groupMembers.actual` 即拒),不是已有成员数。因此在
program 未启用期间,一个 `maxMembers` 落在 **401–3000** 的建圈请求会以这个码失败 ——
看板或客户端若只盯上表其余几个码,这类失败不会被发现。

上线前应为每种拒绝形态补路由级契约测试;或反过来把实现收敛到统一错误码,但那是行为变更,
需与客户端一并改。

### 上线后的风险

若生产中已存在**达到或超过**上述数值的**旧合法**用户(例如加入了 350 个圈子,或恰好
300 个 —— 拦截是「达到即拒」),那么在**部署完成之后、会员计划正式启用之前**,他们的新增操作
会被直接拒绝 —— 而这些数据在旧规则下完全合法。

### 上线前必做

1. **先查生产分布**(启用前的前置数据),但**只有三项能查库**:统计 `groupMembers /
   joinedCircles / notes` 达到或超过 gold 阈值的用户数 —— 它们都对应可计数的持久化行。

   > **判定必须用 `>=`,不能用 `>`。** 拦截谓词都是「达到即拒」:
   > `activeMemberships >= joinedLimit`(`circle.service.ts:126`)、
   > `current >= limit`(`note.service.ts:400`)、准入侧同理(`circle-admission-policy.ts:131`)。
   > 用 `>` 统计会把「恰好 300 个圈子」「恰好 500 条笔记」「恰好 400 人的圈子」算作 0,
   > 从而放行灰度 —— 而这些用户的**下一次操作就会立即报错**。
   > 另注:`groupMembers` 是**按每个自有圈子**计量,不是用户级总数;夹具需同时覆盖
   > `limit - 1` 与 `limit` 两档。

2. **`cityFilters` 查不到分布,必须换一种审计方式**:它没有 per-user 存储,
   `CirclePlazaService.getFeed` 是拿**本次请求**的 `cities` 参数直接与配额比长度。
   因此数据库审计会显示为 0。改用接口/客户端用量或埋点审计,或在启用前豁免这一项请求级配额。

   > **但告警范围要按实际档位收窄。** program 未启用时 floor 是
   > `Math.max(actual.level, 2)` —— 是**下限**,不是把所有人压成 gold:钻石仍是 50 个城市、
   > 超级仍是 1000。所以「请求含 11 个以上城市即 403」只对**实际档位 ≤ gold** 的用户成立;
   > 一条笼统的「>10 城市」埋点规则会把钻石/超级的**合法流量**误判为异常。
   > 用例应覆盖:program disabled 下,11 个城市对普通用户被拒、对钻石/超级放行。
3. 若不为 0,**把「营销展示 floor」与「启用前强制配额」解耦**:floor 只用于
   *展示档位与功能可见性*,配额强制在 program 未启用时不设上限(或按旧规则放行),
   待正式启用后再切到 catalog 数值。
4. 解耦后补单测:覆盖「program disabled + 存量超额用户 → 不被拦截」与
   「program enabled → 正常按 catalog 拦截」两个方向。

---

## 2. 历史 Release workflow 可绕过 schema 兼容下限

**当前**:无影响(从未部署)。**上线后**:P1。

已在 [`DEPLOY.md` §加固待办:锁死历史 workflow 绕过 floor](../DEPLOY.md) 中完整记录,
含目标修法(SSH ForceCommand)、为何仓库内改不掉、以及在此之前的**运维硬约束**。

上线前要点:该修法落在服务器 `~/.ssh/authorized_keys`,**不在本仓库**;启用 ForceCommand
需同时改造 `release.yml` 的 `bash -s` 传参方式,且必须在 staging 真跑验证。

> **注意区分「换值」和「换名」——只有后者能挡住历史 workflow。**
>
> `release.yml` 里是 `DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}`,表达式在**运行时**从
> 仓库当前的 secret 求值。
>
> - **原地轮换 secret 的值(同名)——无效。** 重跑 launcher 之前的历史 workflow,它并不持有
>   旧私钥快照,而是照样拿到**轮换后的新 key**,于是仍能做 live-tree rsync 并直接执行旧的
>   无守卫 `release-deploy.sh`。同名轮换只能作废 GitHub 之外的密钥副本(本机、其他系统的拷贝)。
> - **改用新 secret 名 + 新服务器 key,并删除旧的 `DEPLOY_SSH_KEY` 与其 authorized key
>   ——有效,可作为上线前的一次性切断。** 历史 workflow 仍引用已不存在的旧 secret,取到空值,
>   其 `Configure SSH` 步骤在 `release.yml:307-311` 的空值校验处直接 `exit 1`,早于任何部署动作。
> - **ForceCommand 才是长期解。** 改名只切断「引用旧名的历史 workflow」这一批;新管线沿用新
>   名之后,同样的绕过路径会随时间重新累积。服务器端 `command=` 限制不依赖任何 secret 名。
>
> 无论走哪条,都须在 staging 验证:重跑一个历史 workflow 被拒绝,且更新后的发版流程仍能成功。

---

## 3. 不可逆重放的空跑不应封死可兼容活色

**当前**:无影响(无生产部署)。**上线后**:P2。

已在 [`DEPLOY.md` §加固待办:不可逆重放的空跑不应封死可兼容活色](../DEPLOY.md) 中完整记录,
含现象、目标修法(持久化每个颜色的 schema 兼容级别)与运维约束。

上线前要点:这段是不可逆迁移的**回滚安全闸**,判断错会造成数据损坏级事故,
本地无法验证 —— 必须在 **staging 真跑**(含备色启动失败注入)后再改。

---

## 待合入(修复已就绪,尚未进入 main)

- **icon 资格分页截断已选圈子 / Circle Builder 资格**(原 P2):与生产数据无关的代码正确性缺陷,
  本地开发即可复现 —— 用户若加入 200 个以上圈子,其已选圈子或符合 Circle Builder 资格的
  成员关系可能排在窗口之外,已保存的有效图标随后会被当作 stale 删除。

  修复见 PR [CircleTeamHub/circle_be#129](https://github.com/CircleTeamHub/circle_be/pull/129)。
  **在该 PR 合入 main 之前,本条仍然成立**:当前 main 的 `IconService.fetchEligibilityMemberships`
  依旧只按 `createdAt DESC` 取每人最新 200 条。合入后再把本条移到「已闭合」。

  另:#129 目前只有单测覆盖(SQL 排序断言),**尚缺**把符合资格的成员关系放到第 201 位之后的
  真实 PostgreSQL 集成回归测试 —— 上线前补上。
