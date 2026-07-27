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
| 建圈 / 入圈配额 | `circle.service.ts`、`circle-admission-policy.ts` | `MEMBERSHIP_JOINED_CIRCLE_QUOTA_REACHED` |
| 圈子成员容量 | `circle-admission-policy.ts` | `CIRCLE_MEMBER_LIMIT` |
| 广场城市筛选 | `circle-plaza.service.ts` | `CITY_FILTER_QUOTA_REACHED` |
| 笔记存储 | `note.service.ts`(`assertNoteStorageAvailable`) | `NOTE_STORAGE_QUOTA_REACHED` |

上线前应为每种拒绝形态补路由级契约测试;或反过来把实现收敛到统一错误码,但那是行为变更,
需与客户端一并改。

### 上线后的风险

若生产中已存在超过上述数值的**旧合法**用户(例如加入了 350 个圈子),那么在
**部署完成之后、会员计划正式启用之前**,他们的新增操作会被直接拒绝 —— 而这些数据在旧规则下
完全合法。

### 上线前必做

1. **先查生产分布**(启用前的前置数据),但**只有三项能查库**:统计 `groupMembers /
   joinedCircles / notes` 各自超过 gold 阈值的用户数 —— 它们都对应可计数的持久化行。
2. **`cityFilters` 查不到分布,必须换一种审计方式**:它没有 per-user 存储,
   `CirclePlazaService.getFeed` 是拿**本次请求**的 `cities` 参数直接与配额比长度。
   因此数据库审计会显示为 0,而一个携带 11–1000 个城市(`PlazaFeedSearchDto` 仍接受)的
   既有客户端请求,会在程序未启用期间开始返回 403。改用接口/客户端用量或埋点审计,
   或在启用前豁免这一项请求级配额;并补一条「program disabled + 请求含 10 个以上城市」的用例。
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

> **别指望靠轮换部署 key 挡住它。** `release.yml` 里是
> `DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}` —— 表达式在**运行时**从仓库当前的 secret
> 求值。重跑一个 launcher 引入之前的历史 workflow,它并不持有旧私钥快照,而是照样拿到
> **轮换后的新 key**,于是仍能做 live-tree rsync 并直接执行旧的无守卫 `release-deploy.sh`。
> 轮换只能作废 GitHub 之外的密钥副本(如本机、其他系统留存的拷贝);唯一真正的阻断层是
> 服务器端受限的 ForceCommand key。落地后须在 staging 验证:重跑一个历史 workflow 会被拒绝。

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
