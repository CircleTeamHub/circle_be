# Phase 3 — Coin / Wallet Review

> 范围:`src/coin/` 全部(`coin.module.ts` / `coin.controller.ts` / `coin.service.ts` / `dto/coin.dto.ts` / `coin.service.spec.ts`)+ `prisma/schema.prisma` 的 `Wallet` / `CoinTransaction` / `CoinGift` / `CoinTxType`。
> 颗粒度:逐文件逐行。
> 这是**金钱 P0** 模块 —— review 标准比其它模块更严。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **HIGH** | [coin.service.ts:49-197](src/coin/coin.service.ts:49) `sendGift` | **无 idempotency-key**。内部 retry loop(`MAX_GIFT_TX_ATTEMPTS`)只防序列化冲突,**不防客户端重试**。客户端超时重发 `POST /coin/gift` → 两笔独立事务 → 双重扣款 + 双重到账。`coinGiftLimiter`(20/15min/IP)挡不住一次合法的重复提交。金钱场景必须幂等 |
| 2 | **HIGH(功能缺失)** | [coin.service.ts:201-227](src/coin/coin.service.ts:201) `adminTopUp` | `adminTopUp` **无任何路由、无任何调用方**(已 grep 全仓确认)。这是系统里**唯一的充值/credit 入口** —— 它不可达意味着**没有任何途径让 coin 进入系统**:所有钱包默认 `balance=0`,`sendGift` 对所有人永远 "Insufficient coins"。Coin 功能端到端不可用 |
| 3 | **MED** | [coin.service.ts:26-37](src/coin/coin.service.ts:26) `getWallet` | findUnique → 若 null 则 create 的 auto-create 有 race:两个并发首次访问 → 都 null → 都 create → 后者命中 `Wallet.userID @unique` 的 P2002。且这是个 **GET 端点在写库** |
| 4 | **MED** | [coin.service.ts:109-120](src/coin/coin.service.ts:109) + [:133-143](src/coin/coin.service.ts:133) | 在 `$transaction` 回调里用 `Promise.all` 并发跑多条查询 —— Prisma interactive transaction 是单连接,官方明确不建议在事务回调内并发查询(执行顺序不确定、极端情况可能问题)。应改顺序 `await` |
| 5 | **MED** | [coin.service.ts:201-227](src/coin/coin.service.ts:201) `adminTopUp`(若启用) | 不校验 target user 是否存在/ACTIVE → `wallet.upsert` 的 `create` 触发 `Wallet.user` 外键 → P2003 → 落到 PrismaExceptionFilter 的 400 "Invalid reference",对管理员不友好;且 `amount` 无上限(可一次 top-up 接近 Int 溢出) |
| 6 | **MED** | [coin.service.spec.ts](src/coin/coin.service.spec.ts) | 金钱模块**只有 2 个测试**,且**没有 happy path**(成功 gift 完全没测)。缺:自赠拒绝、超单笔上限、日限额、成功扣款+到账+txs、P2034 重试、adminTopUp、getWallet auto-create |
| 7 | **MED** | [coin.service.ts:39-45](src/coin/coin.service.ts:39) `getTransactions` | `take: 50` 硬编码,无 cursor/分页 —— 用户永远看不到第 51 笔之前的历史。金钱流水不可翻页是合规/对账隐患 |
| 8 | LOW | [coin.controller.ts:32,39,47](src/coin/coin.controller.ts:32) | 3 处 `@Req() req: any` —— 应用 Phase 1 的 `RequestWithUser` |
| 9 | LOW | [coin.service.ts:138-142](src/coin/coin.service.ts:138) | recipient `balance: { increment }` 无溢出防护;`Int` 上限 ~2.1e9,当前 GIFT 上限下不现实,但金钱字段建议 `BigInt` 或显式上限校验 |
| 10 | LOW | [coin.service.ts:145-152](src/coin/coin.service.ts:145) | `CoinGift.message` / `CoinTransaction.note` 存用户输入(100 字),无注入过滤;在流水 UI 渲染若按 HTML 处理则有 stored-XSS 风险(与 friend evidence 同类) |
| 11 | LOW | [coin.service.ts:64-70](src/coin/coin.service.ts:64) | recipient ACTIVE 检查在事务**外**;recipient 在 check 与 txn 之间被封,仍能收到 coin(窗口极窄) |
| 12 | LOW | [coin.service.ts:201-227](src/coin/coin.service.ts:201) `adminTopUp` | 若将来加路由,**必须** `@UseGuards(JwtGuard, AdminGuard)`;现状无路由所以暂无暴露,但要在加路由时强制 |
| 13 | LOW | [coin.dto.ts:35-43](src/coin/dto/coin.dto.ts:35) `CoinTransactionDto` | `type` 声明为 `string` 而非 `CoinTxType` 枚举,Swagger 不展示可选值 |

共 **13 项**:HIGH 2、MED 5、LOW 6。

---

## 1. File: `src/coin/coin.module.ts` (10 lines)

标准 module,`exports: [CoinService]`(供其它模块用,目前无人 import)。无 `@Global()`。**OK**。

---

## 2. File: `src/coin/coin.controller.ts` (55 lines)

### Walkthrough
- L22-25 类装饰:`@ApiTags` + `@ApiBearerAuth` + **`@UseGuards(JwtGuard)`(类级)** + `@Controller('coin')` ✓
- L29-34 `GET /coin/wallet` — `@Req() req: any`(LOW-8);调 `getWallet`
- L36-41 `GET /coin/transactions` — 同 `req: any`
- L43-54 `POST /coin/gift` — `@HttpCode(NO_CONTENT)` ✓;`SendGiftDto` 强类型 ✓;`req: any`
- **无 admin / top-up 路由** — `adminTopUp` 不可达(HIGH-2)
- 配 `coinGiftLimiter`(setup.ts,20/15min/IP)✓ 但见 HIGH-1

### Findings
- [HIGH-2] 无充值路由 → coin 无法进入系统
- [LOW-8] 3 处 `@Req() req: any`

### Verified OK
- 类级 JwtGuard 覆盖全部路由
- `POST /gift` 用 `@Body() dto: SendGiftDto` 强 DTO
- HttpCode 语义正确

---

## 3. File: `src/coin/dto/coin.dto.ts` (43 lines)

### Walkthrough
- **SendGiftDto** — `recipientId @IsUUID`、`amount @IsInt @Min(1)`、`message @IsOptional @IsString @MaxLength(100)`
  - `@Min(1)` + 服务端 `amount > GIFT_MAX_SINGLE` 检查 → amount ∈ [1, 10000] ✓
  - 全局 ValidationPipe `enableImplicitConversion` 会把 `"100"` 转 100;`@IsInt` 拒小数 ✓
- **WalletDto** — id/userID/balance/updatedAt,与 Wallet 模型对齐 ✓
- **CoinTransactionDto** — `type: string`(应为枚举,LOW-13);其余 OK

### Findings
- [LOW-13] `type` 用 `string` 而非 `CoinTxType`

### Verified OK
- gift amount 上下界都有(DTO `@Min(1)` + service 上限)
- message 长度受限

---

## 4. File: `src/coin/coin.service.ts` (235 lines)

### 4.1 L12-16 常量
- `GIFT_MAX_SINGLE=10_000`、`GIFT_DAILY_LIMIT=50_000`、`MAX_GIFT_TX_ATTEMPTS=3` — magic number 建议 env 化,但可接受

### 4.2 L26-37 `getWallet` — 🟠 MED-3
- findUnique → null 则 `wallet.create`
- **race**:并发首访 → 双 create → P2002
- **GET 写库**:auto-create 是写操作,放在 GET 语义里
- 修复:`this.prisma.wallet.upsert({ where: { userID }, update: {}, create: { userID } })` 一步到位、幂等

### 4.3 L39-45 `getTransactions` — 🟠 MED-7
- `findMany({ userID }, orderBy createdAt desc, take: 50)`
- 硬上限 50,无 cursor → 第 51 笔以前的流水永久不可见

### 4.4 L49-197 `sendGift` — 核心,逐段

- **L55-57** 自赠拒绝 ✓
- **L58-62** `amount > GIFT_MAX_SINGLE` 拒绝 ✓
- **L64-70** recipient 必须 ACTIVE(事务外,LOW-11)
- **L73-84** 必须 ACCEPTED 好友 ✓
- **L87-88** `todayStart` 当日 0 点
- **L90-192** retry loop(最多 3 次):
  - **L92-178** `$transaction(..., { isolationLevel: Serializable })` ✓ —— 用 Serializable 是金钱场景的正确选择
  - **L94-107** 日限额:在事务内 `aggregate(GIFT_SENT today)` → `totalSentToday + amount > limit` 拒。事务内做保证一致读 ✓
  - **L109-120** `Promise.all([wallet.upsert(sender), wallet.upsert(recipient)])` — 🟠 **MED-4**:事务回调内并发查询,Prisma 反模式
  - **L122-131** `wallet.updateMany({ where: { userID: senderId, balance: { gte: amount } }, data: { decrement } })` → `count !== 1` 则 "Insufficient coins" — ✅ **这是原子条件扣款的正确写法**,没有先读后写的 TOCTOU
  - **L133-143** `Promise.all([findUniqueOrThrow(sender), wallet.update(recipient increment)])` — 同 MED-4
  - **L145-152** `coinGift.create`
  - **L154-173** `coinTransaction.createMany` 两条(GIFT_SENT 负 / GIFT_RECEIVED 正),各带 `balance` 快照 + `relatedID = gift.id` ✓
  - **L180-191** catch:P2034(序列化冲突)且未到上限 → continue 重试;否则 throw。**最后一次仍冲突也会 throw(`attempt < 3` 为 false → 落到 throw)** ✓ 逻辑正确,无"静默不抛"bug
- **L194-196** 成功日志

**HIGH-1 复现**:
```
T1: 客户端 POST /coin/gift {recipient, amount:500},服务端事务提交成功,但响应在网络上丢失
T2: 客户端超时,自动重试同一请求
T3: 服务端第二次执行 sendGift —— 没有任何幂等键去识别"这是同一笔"
T4: 第二个事务同样成功 → sender 共扣 1000,recipient 共收 1000
T5: 用户看到余额少了一倍,产生客诉/对账差异
```
retry loop 完全无法防这个 —— 它只在**同一次** service 调用内对 P2034 重试。

### 4.5 L201-227 `adminTopUp` — 🔴 HIGH-2 / 🟠 MED-5
- L206 `amount <= 0` 拒;**无上限**(MED-5)
- L208-226 `$transaction`:`wallet.upsert(increment / create balance:amount)` + `coinTransaction.create(RECHARGE)`
- **不校验 targetUserId 存在** → 不存在时外键 P2003(MED-5)
- **整段无路由、无调用方** → 死代码 + 系统唯一充值路径不可达(HIGH-2)

### 4.6 L229-234 `isRetryableTransactionError`
- 判 `PrismaClientKnownRequestError` && code `P2034` ✓ 正确识别序列化冲突

### Findings
- [HIGH-1] sendGift 无幂等
- [HIGH-2] adminTopUp 死代码 + 无充值入口
- [MED-3] getWallet auto-create race
- [MED-4] L109/L133 事务内 Promise.all
- [MED-5] adminTopUp 不校验 target / 无上限
- [MED-7] getTransactions 无分页
- [LOW-9] increment 无溢出防护
- [LOW-10] message/note 无注入过滤
- [LOW-11] recipient ACTIVE 检查在事务外

### Verified OK ✅(金钱关键项,逐一确认)
- **原子条件扣款**:`updateMany({ balance: { gte: amount } })` + `count` 检查 —— 无 read-then-write TOCTOU,这是教科书写法
- **Serializable 隔离级别** —— 金钱事务正确选择
- **序列化冲突重试** —— P2034 识别正确,最后一次仍会抛出
- **日限额在事务内做** —— 一致读
- **CoinTransaction append-only** —— service 只 `create`/`createMany`,从不 update 一条已存在的 tx
- **每条 tx 存 `balance` 快照 + `relatedID`** —— 可对账、可溯源
- **扣款失败 / 余额不足时**,`coinGift.create` 与 `coinTransaction.createMany` 都不会执行(在同一事务内,扣款 count!=1 直接 throw)
- **好友关系校验** —— 只能赠予 ACCEPTED 好友
- **自赠、超单笔上限** —— 都在进入事务前拦截

---

## 5. File: `src/coin/coin.service.spec.ts` (112 lines) — 🟠 MED-6

### Walkthrough
- mock:`tx`(wallet/coinGift/coinTransaction)、`prisma`(user/friend/wallet/coinTransaction/$transaction)
- 测 1:gift 给 BANNED recipient → NotFoundException ✓
- 测 2:`wallet.updateMany` count=0 → BadRequestException,且后续 update/create 不执行 ✓

### 缺失(对金钱模块是严重缺口)
- ❌ **成功 gift 的 happy path**(扣款 + 到账 + 2 条 tx + gift 记录)
- ❌ 自赠拒绝
- ❌ `amount > GIFT_MAX_SINGLE` 拒绝
- ❌ 日限额触发
- ❌ 非好友拒绝
- ❌ P2034 → 重试 → 成功
- ❌ P2034 → 重试 3 次仍失败 → 抛出
- ❌ `adminTopUp`(任何 case)
- ❌ `getWallet` auto-create
- ❌ `getTransactions`

---

## 6. 修复建议(只列 HIGH/MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 | `POST /coin/gift` 增加 `Idempotency-Key` 头要求。最简实现:加 `CoinGift.idempotencyKey String? @unique`(migration),sendGift 收 key,`coinGift.create` 带 key,catch P2002 → 返回首次结果(或 200 幂等)。无 Redis 也可做 |
| #2 | 决定 coin 经济模型:要么实现充值(给 `adminTopUp` 加 `@Post('admin/topup')` + `AdminGuard`,或接入支付),要么明确删除 coin 模块。**当前状态:功能不可用** |
| #3 | `getWallet` 改 `wallet.upsert({ where, update: {}, create: { userID } })` |
| #4 | 把 L109-120 与 L133-143 的 `Promise.all` 拆成顺序 `await`(事务内不并发) |
| #5 | `adminTopUp` 先 `user.findUnique` 校验 target 存在 + ACTIVE;`amount` 加上限(如 ≤ 1_000_000);加路由时强制 `AdminGuard` |
| #6 | 补金钱模块测试:至少覆盖 happy path、日限额、P2034 重试、adminTopUp |
| #7 | `getTransactions` 加 cursor 分页 |

---

## 7. Phase 3 总评

- **事务内核质量高**:Serializable 隔离 + 原子条件扣款(`updateMany balance gte`)+ 序列化冲突重试 + append-only 流水 + balance 快照 —— 这套是金钱处理的**正确骨架**,比 friend / 多数模块都扎实
- **但有两个致命缺口**:
  1. **无幂等**(HIGH-1)—— 金钱接口最不能少的就是幂等,网络重试 = 双重扣款
  2. **充值入口不可达**(HIGH-2)—— `adminTopUp` 死代码,系统里 coin 无法产生,整个 gift 功能空转
- **次要**:GET 写库 race、事务内 Promise.all 反模式、金钱模块测试覆盖严重不足
- **结论**:Coin 模块"会算账但收不到钱也防不住重复扣" —— 内核对、边界缺。HIGH-1/2 必须先解决才能上线

下一步:Phase 4a — Note core。
