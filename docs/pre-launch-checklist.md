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

返回的这个 level 会流向所有强制拦截路径(`circle-admission-policy.ts`、`circle.service.ts`、
`circle-plaza.service.ts`、`note.service.ts`),最终由 `assertQuotaAvailable` 抛
`MEMBERSHIP_QUOTA_REACHED`。

### 上线后的风险

若生产中已存在超过上述数值的**旧合法**用户(例如加入了 350 个圈子),那么在
**部署完成之后、会员计划正式启用之前**,他们的新增操作会被直接拒绝 —— 而这些数据在旧规则下
完全合法。

### 上线前必做

1. **先查生产分布**(启用前的前置数据):统计 `groupMembers / joinedCircles / notes / cityFilters`
   四项各自超过 gold 阈值的用户数。若为 0,可直接按现状启用。
2. 若不为 0,**把「营销展示 floor」与「启用前强制配额」解耦**:floor 只用于
   *展示档位与功能可见性*,配额强制在 program 未启用时不设上限(或按旧规则放行),
   待正式启用后再切到 catalog 数值。
3. 解耦后补单测:覆盖「program disabled + 存量超额用户 → 不被拦截」与
   「program enabled → 正常按 catalog 拦截」两个方向。

---

## 2. 历史 Release workflow 可绕过 schema 兼容下限

**当前**:无影响(从未部署)。**上线后**:P1。

已在 [`DEPLOY.md` §加固待办:锁死历史 workflow 绕过 floor](../DEPLOY.md) 中完整记录,
含目标修法(SSH ForceCommand)、为何仓库内改不掉、以及在此之前的**运维硬约束**。

上线前要点:该修法落在服务器 `~/.ssh/authorized_keys`,**不在本仓库**;启用 ForceCommand
需同时改造 `release.yml` 的 `bash -s` 传参方式,且必须在 staging 真跑验证。
首次上线前应完成**部署 key 轮换**,使引入 launcher 之前的历史 workflow 所持凭据失效。

---

## 3. 不可逆重放的空跑不应封死可兼容活色

**当前**:无影响(无生产部署)。**上线后**:P2。

已在 [`DEPLOY.md` §加固待办:不可逆重放的空跑不应封死可兼容活色](../DEPLOY.md) 中完整记录,
含现象、目标修法(持久化每个颜色的 schema 兼容级别)与运维约束。

上线前要点:这段是不可逆迁移的**回滚安全闸**,判断错会造成数据损坏级事故,
本地无法验证 —— 必须在 **staging 真跑**(含备色启动失败注入)后再改。

---

## 已闭合

- **icon 资格分页截断已选圈子 / Circle Builder 资格**(原 P2):与生产数据无关的代码正确性缺陷,
  本地开发即可复现,已修复并合入 —— 见 PR
  [CircleTeamHub/circle_be#129](https://github.com/CircleTeamHub/circle_be/pull/129)。
