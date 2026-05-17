# 成熟度抬升手册 — 让全项目代码达到 invitation 流程的水准

> 背景:Phase 5 review 认定 `circle-invitation` 的 `respond` / `adminApprove` 是全项目并发处理最成熟的一段。
> 本文把"成熟"拆成可复制的要素,并区分**哪些能抽成共享基础设施(一次投入、全模块受益)**、**哪些只能靠纪律**。

---

## 1. "成熟"到底由什么构成

invitation 流程的成熟 = 5 个习惯的叠加,缺一不可:

| 要素 | invitation 怎么做的 | 多数其它模块的现状 |
|---|---|---|
| **A. 并发正确性** | Serializable 隔离 + P2034 重试 + 原子操作(`updateMany` 带 status 守卫做状态机、`increment` 做计数)+ 事务内重新校验前置条件 | friend `sendRequest` 靠 SELECT-then-INSERT(已补 advisory lock);note group 重名 TOCTOU |
| **B. DB 层不变量兜底** | ⚠️ **invitation 自己这块也不够** —— 没有 `@@unique` 防并发重复 PENDING 邀请(Phase 5 #6) | friend / FriendReport / FriendActivity / NoteGroup / CoinGift 全缺关键 `@@unique` |
| **C. 授权是命名的、可测的函数** | `assertCanViewInvitation` 单一函数,集中判定 applicant/inviter/verifier/owner-admin | 多数模块把 owner 判定散落在各 method 内联 |
| **D. 副作用与事务隔离** | OpenIM 调用在事务**外**、非阻塞、`catch` | coin / circle 也做到了;friend `sendRequest` 干脆不碰 IM |
| **E. 失败路径有测试** | 设计可测(虽然 invitation 自己的 spec 也偏薄) | friend 测试覆盖死代码路径;coin 原本没有 happy path |

**关键洞察**:成熟 = A(事务纪律)**且** B(DB 约束兜底)。invitation 强在 A 弱在 B —— 真正的目标比 invitation 还要再高一档。

---

## 2. 高杠杆动作:把可复制的部分抽成共享基础设施

不能指望每个模块作者都重新推导一遍。把下面四样抽出来,新代码"调一个方法"就自动拿到成熟行为。

### 2.1 抽 `runSerializableTransaction` —— 当前被复制了 3 份

完全相同的重试循环 + `isRetryableTransactionError` 现在散在三处:

- `coin.service.ts`:`MAX_GIFT_TX_ATTEMPTS` + `sendGift` 里的 for 循环 + `isRetryableTransactionError`
- `circle.service.ts`:`MAX_JOIN_TX_ATTEMPTS` + `joinCircle` 里的 for 循环 + `isRetryableTransactionError`
- `circle-invitation.service.ts`:`MAX_INVITATION_TX_ATTEMPTS` + `runInvitationTransaction` + `isRetryableTransactionError`

**抽成一处**(建议 `src/prisma/transaction.util.ts` 或 `PrismaService` 上加方法):

```ts
// 伪代码
async function runSerializableTransaction<T>(
  prisma: PrismaService,
  fn: (tx) => Promise<T>,
  { maxAttempts = 3 } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (e) {
      if (prismaErrorCode(e) === 'P2034' && attempt < maxAttempts) continue;
      throw e;
    }
  }
  throw new Error('unreachable');
}
```

收益:`note` 的 `updateNote`、`friend` 的 `handleRequest` / `sendRequest`、未来任何多行写入,只要 `runSerializableTransaction(...)` 一行就拿到"Serializable + 重试" —— 不再靠作者记得抄。

### 2.2 抽 `prismaErrorCode(error)` —— P2002 / P2025 / P2034 判定

我在 friend 模块加过 `prismaErrorCode`;coin / circle 各有一份 `isRetryableTransactionError`。统一成一个工具:`prismaErrorCode(e) === 'P2002'` 等。配合 2.1。

### 2.3 抽 `paginate()` helper

列表分页现在三种状态并存:circle/plaza 做了 `{items,total,page,limit}`、note 做了 take/skip 但返回裸数组、friend 完全没分页。定义一个标准信封 + helper,所有 `findMany` 列表统一走它。一次定义,消除 friend Phase 2#4 / note 4b#4 / 各处的分页缺口。

### 2.4 抽 `assertUrlFromOwnStorage(url)` guard

note 模块 Phase 4b 我加了 `assertMediaUrlsAreSafe`;user 模块有 `assertUrlsAreSafe`(还用了较弱的裸 `startsWith`);circle/plaza 的 `images`/`avatarUrl` 完全没有。抽成一个共享 guard(用 note 那版更严的"prefix 后必跟 `/`"逻辑),三个模块统一引用。

---

## 3. 另一半:DB 约束兜底 —— 一个 migration 解锁四个模块

要素 B 必须靠 schema。把散落在各 review 里"需要 migration"的项**合并成一个 migration PR**:

| 约束 | 解决的 finding |
|---|---|
| `Friend` partial unique `(userID, friendID) WHERE state IN (PENDING,ACCEPTED)` | friend 2a#1(目前靠 advisory lock 兜) |
| `FriendReport @@unique([reporterID, targetID, category])` | friend 2a#6 去重 TOCTOU |
| `FriendActivity @@unique([requestId, viewerId, type])` | friend 2b#6 并发双写 |
| `NoteGroup @@unique([ownerID, name])` | note 4a#2 重名 TOCTOU |
| `CircleInvitation` partial unique `(circleID, applicantID) WHERE status=PENDING` | circle 5#6 重复邀请 |
| `CoinGift.idempotencyKey String? @unique` | coin 3#1 幂等(headline blocker) |
| `User.activitiesBackfilledAt DateTime?` | friend 2b#1 backfill 寄生读路径 |

加上约束后,应用层的 `findFirst`-then-`create` 就可以改成 `create` + `catch P2002`,TOCTOU 彻底消失 —— 这就是 invitation 也还差的那一档。

---

## 4. 计数器策略 —— 一个架构决策

`memberCount` / `postCount` / `mediaCount` 这类反范式计数器在多处漂移(circle 5#8:用户注销不回补)。两条路二选一:

- **A. 去掉反范式计数**,用 Prisma `_count` 关系计数实时算 —— 无漂移,代价是查询多一个 join
- **B. 保留计数**,但 (1) 所有增减都在事务内、(2) 加一个定期对账 job 把 `count` 校正回真实值

note 的 `_count.memberships` 已经是 A 的样子;circle 是 B 但缺对账。**建议统一往 A 收**(除非有性能实测理由)。

---

## 5. 抽不掉的部分 —— 只能靠纪律,但可以用清单固化

有三件事没法抽成代码:

1. **判断"何时需要事务 / Serializable"** —— 决策本身
2. **写失败路径测试** —— 否则成熟的设计也会被后续改动悄悄破坏
3. **判断"这个字段算不算跨用户内容,要不要校验来源"**

对策:把它做成 **PR checklist**(放进 `.github/PULL_REQUEST_TEMPLATE` 或 CLAUDE.md),每个改写路径的 PR 必须自答:

```
[ ] 这个改动是否 ≥2 行写入 ≥2 张表?是 → 走 runSerializableTransaction
[ ] 有没有 SELECT-then-INSERT/UPDATE?有 → 要么 DB @@unique + catch,要么 advisory lock
[ ] 计数器增减是否在同一事务内?
[ ] 新增的 client 输入里有 URL / 富文本吗?→ 过 origin guard / 注入消毒
[ ] 鉴权判定是不是抽成了命名函数?
[ ] 失败路径(403 / 冲突 / 容量满 / 并发)有没有测试?
[ ] 外部调用(OpenIM / S3)是否在事务外、非阻塞、catch?
```

这正是本次 review 用的 `nestjs-production-review` skill 的 5 个边界 —— 把它常态化成每个 PR 的自检。

---

## 6. 落地优先级

| 顺序 | 动作 | 杠杆 | 工作量 |
|---|---|---|---|
| 1 | **合并 migration**(§3) | 一次解锁 friend/note/circle/coin 的约束兜底 | 中 |
| 2 | 抽 `runSerializableTransaction` + `prismaErrorCode`(§2.1/2.2),三个模块改为调用它 | 消除复制、新代码自动受益 | 小 |
| 3 | 把 SELECT-then-INSERT 全改成 `create + catch P2002`(依赖 #1) | TOCTOU 清零 | 中 |
| 4 | 抽 `assertUrlFromOwnStorage` + `paginate`(§2.3/2.4),全模块替换 | 消除内容信任 / 分页缺口 | 中 |
| 5 | 计数器策略统一(§4) | 消除 memberCount 类漂移 | 中 |
| 6 | PR checklist 固化(§5) | 防止回退 | 小 |
| 7 | N+1 扫除(invitation 三个 list、friend list)+ 失败路径补测试 | 性能 + 防腐 | 中 |

---

## 6'. 执行进度(Phase 0-4 应用)

> `npx tsc --noEmit` 0 errors · `jest` 28 suites / 173 tests pass。

### ✅ 已完成 —— §2 共享基础设施抽取

| 项 | 产出 |
|---|---|
| §2.1/§2.2 | 新建 `src/utils/prisma-tx.ts`:`runSerializableTransaction()` + `prismaErrorCode()` |
| §2.1 落地 | `coin.service.ts` 的 `sendGift`(原 `MAX_GIFT_TX_ATTEMPTS` + 重试循环)与 `adminTopUp`(原裸 `$transaction`)改为调用 `runSerializableTransaction`;删除模块内重复的 `isRetryableTransactionError` |
| §2.4 | 新建 `src/utils/storage-url.ts`:`isUrlFromStorage()` + `assertUrlsFromStorage()`(prefix 后必跟 `/`,堵 `host.attacker.com` 旁路) |
| §2.4 落地 | `user.service.ts` `assertUrlsAreSafe` 改用共享 guard —— **顺带修掉 Phase 1 LOW:user 模块原来的裸 `startsWith` 旁路漏洞**;`note.service.ts` `assertMediaUrlsAreSafe` 改用共享 guard |

> circle / circle-invitation / circle-plaza(Phase 5)仍保留各自的事务重试 / URL guard 内联实现 —— 已是正确的副本;待统一改调共享工具(util 已就绪)。

### ✅ 已完成 —— §3 migration + 代码适配

migration `20260516000000_maturity_constraints` 已应用到实库(详见 [`97-migration-applied.md`](./97-migration-applied.md)):
- 新列:`User.activitiesBackfilledAt`、`CoinGift.idempotencyKey`
- 普通唯一索引:`FriendReport(reporterID,targetID,category)`、`FriendActivity(requestId,viewerId,type)`、`CoinGift(idempotencyKey)`
- partial unique(raw SQL):`Friend` 活跃对、`CircleInvitation` 待审、`NoteGroup` 活跃名

代码适配(§6 步骤③):coin `sendGift` 接入 `Idempotency-Key` 头 + catch-P2002 幂等;friend `reportFriend` / note `createGroup`+`updateGroup` 改 catch-P2002;`createFriendActivities` + backfill 加 `skipDuplicates`;`backfillLegacyActivitiesForViewer` 用 `activitiesBackfilledAt` 一次性 gate(消除 friend 2b#1 的读路径寄生)。

### ⏳ 未完成

§4(计数器策略)、§5(PR checklist)未做 —— 分别是架构决策与流程项,不属代码改动。

---

## 7. 一句话总结

invitation 之所以成熟,不是因为它"更聪明",而是因为它**同时做对了事务纪律 + 原子操作 + 命名授权 + 副作用隔离**。
让其它模块追上的最快方式不是逐个手抄,而是:
**① 把可复制的(事务重试 / 错误码 / 分页 / URL 守卫)抽成共享工具 → 调用即获得;
② 把约束兜底(`@@unique`)沉到 DB 一次性补齐 → TOCTOU 从根上消失;
③ 把判断类的(何时要事务、要不要测)固化成 PR checklist → 防止回退。**
能自动化的自动化,不能自动化的清单化。
