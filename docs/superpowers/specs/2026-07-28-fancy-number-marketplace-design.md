# 靓号专区购买与续费设计

## 背景与现状

系统当前有两层用户标识：

- `User.id` 是内部 UUID，关联数据库、JWT `userId` 和 OpenIM，不因购买靓号而变化。
- `User.accountId` 是公开账号句柄，用于资料展示和好友搜索。注册时自动生成 6 位小写字母数字，之后可通过 `POST /auth/change-account-id` 修改。账号规则是 4–32 位字母、数字、下划线或短横线，统一小写存储，并有大小写不敏感唯一索引。

商城已有“自选靓号”和“续费靓号”的静态入口，但没有库存、购买或续费能力。现有 `User.fancyNumber` 只是布尔值，没有号码归属和到期时间。

系统内用户所称的“积分”对应 `Wallet.balance` 和 `CoinTransaction`。`User.creditScore` 是 0–100 的信用分，不可用于消费。

会员系统目前会给钻石/超级会员发普通/高级靓号券。本功能取消靓号等级：钻石会员不再获得靓号权益，超级会员可以从库存免费选择一个永久靓号。

## 目标

- 管理员维护可售靓号库存。
- 普通用户以每月 100 积分购买或续费靓号，每次可选 1–12 个自然月。
- 购买时公开 `accountId` 切换为靓号；原账号在租期内为本人保留。
- 到期未续费时自动恢复原账号并重新上架靓号。
- 超级会员可以免费选择一个永久靓号。
- 已有付费靓号的用户升级为超级会员时，当前靓号自动转为永久，不退已支付积分。
- 所有扣款、订单、租约、账号切换和库存变更具备事务一致性、幂等性和并发安全。
- 更新会员详情：超级会员权益显示“永久靓号”，停止新发普通/高级靓号券。

## 非目标

- 不实现自动续费。
- 不支持用户主动提前放弃或更换有效靓号。
- 不支持退款、转赠、拍卖、动态定价或不同等级靓号。
- 不修改内部 UUID、JWT `userId` 或 OpenIM 用户 ID。
- 不物理删除已有靓号、租约、订单或旧会员权益历史。

## 已确认的业务规则

1. 靓号由管理员预先录入库存，用户不能自行输入任意号码。
2. 所有靓号价格相同：100 积分/自然月。
3. 普通用户首购和续费均可一次选择 1–12 个月。
4. 续费从当前到期时间按 UTC 自然月顺延；月末落到目标月最后一天。例如 1 月 31 日顺延一个月得到 2 月最后一天。
5. 仅支持手动续费。
6. 到期后恢复购买前的普通账号，原靓号重新上架。
7. 有效靓号期间禁止使用现有修改账号接口。
8. 超级会员免费选择一个靓号并永久占用。
9. 用户先付费租用靓号、之后升级为超级会员时，当前号码自动转永久，不退积分。
10. 当前数据库中的 `fancyNumber=true` 用户按历史永久靓号迁移。

## 架构

### AccountIdentifierModule

统一管理账号命名空间。`User.accountId` 继续作为现有 API 的当前公开账号，但每次创建或修改前都必须在账号标识注册表中取得唯一占用。

注册表同时保护：

- 用户当前公开账号；
- 租用靓号期间等待恢复的原账号；
- 邀请码；
- 管理员录入的靓号库存。

这样可以在数据库唯一约束和事务的共同保护下，避免其他用户在租期内抢走原账号，也避免普通改号或注册流程取得已入库的靓号。

### FancyNumberModule

独立负责靓号库存、租约、订单、购买、续费、到期恢复和超级会员永久化。商城控制器只负责 HTTP 契约，业务逻辑由该模块完成。

### CoinModule

在现有 `CoinService` 中增加可在调用方事务内执行的商城扣款能力。钱包扣减使用带 `balance >= totalPrice` 条件的原子更新，订单、租约、账号切换和 `PURCHASE` 流水在同一个可串行化事务内完成。

### MembershipModule

会员目录不再区分普通/高级靓号。钻石会员不发靓号券，超级会员详情显示“永久靓号”。超级会员资格本身就是免费永久选号资格，不依赖旧券记录。

会员升级事务在用户已有有效付费租约时调用靓号模块的事务内永久化操作。没有当前靓号时不预占号码，用户之后自行从商城选择。

### 到期处理器

每分钟分批处理到期租约。多实例使用数据库条件更新/锁避免重复领取，同一租约的恢复在单个可串行化事务内完成。

权限判断不能只依赖定时任务更新后的布尔值。所有靓号门槛判断同时使用 `fancyNumberExpiresAt` 和永久标志计算实时有效状态，保证到期后即使清理任务尚未运行也默认拒绝。

## 数据模型

### AccountIdentifier

账号标识注册表以标准化小写 `value` 为主键。

建议字段：

- `value String @id`
- `currentUserID String? @unique`：当前公开使用者；
- `reservedForUserID String? @unique`：租期内等待恢复的原账号归属；
- `inviteOwnerUserID String? @unique`：邀请码归属；
- `createdAt DateTime`
- `updatedAt DateTime`

`FancyNumber.value` 通过外键引用该表。注册表中存在的值默认不可被普通改号流程重新取得；释放普通旧账号时，仅在它不再承担邀请码、原账号保留或靓号库存用途时删除记录。

数据库检查约束和服务事务保证：

- 每个用户最多一个当前账号；
- 每个用户最多一个待恢复账号；
- 当前账号与待恢复账号不能同时指向同一标识；
- 邀请码与当前账号共用同一值时必须属于同一用户；
- 已入库靓号不能被普通账号修改流程取得。

`User.accountId` 保留现有唯一索引，并增加到 `AccountIdentifier.value` 的引用或等价迁移约束。创建用户时先在事务中取得标识，再创建用户并回填标识归属。

### FancyNumber

- `id String @id @default(uuid())`
- `value String @unique`
- `status FancyNumberStatus`
- `sortOrder Int`
- `createdByUserID String`
- `disabledAt DateTime?`
- `createdAt DateTime`
- `updatedAt DateTime`

状态：

- `AVAILABLE`：已上架且可购买；
- `LEASED`：普通用户租用中；
- `PERMANENT`：超级会员或历史用户永久占用；
- `DISABLED`：管理员下架且不可购买。

出租中和永久占用的号码不能下架。管理端不提供物理删除。

### FancyNumberLease

- `id String @id @default(uuid())`
- `userID String`
- `fancyNumberID String`
- `restoreAccountId String`
- `startedAt DateTime`
- `expiresAt DateTime?`
- `permanentAt DateTime?`
- `endedAt DateTime?`
- `endReason FancyNumberLeaseEndReason?`
- `createdAt DateTime`
- `updatedAt DateTime`

`expiresAt=null` 且 `permanentAt!=null` 表示永久租约。使用 PostgreSQL 局部唯一索引保证：

- 同一用户最多一条 `endedAt IS NULL` 的租约；
- 同一靓号最多一条 `endedAt IS NULL` 的租约。

为到期扫描增加 `(endedAt, expiresAt)` 或等价局部索引。

### FancyNumberOrder

- `id String @id @default(uuid())`
- `idempotencyKey String @unique`
- `requestFingerprint String`
- `type FancyNumberOrderType`
- `userID String`
- `fancyNumberID String`
- `leaseID String`
- `months Int?`
- `unitPrice Int`
- `totalPrice Int`
- `previousExpiresAt DateTime?`
- `newExpiresAt DateTime?`
- `createdAt DateTime`

订单类型：

- `PURCHASE`
- `RENEWAL`
- `SUPER_CONVERSION`
- `LEGACY_GRANT`

`requestFingerprint` 绑定用户、操作、号码和月份。同一幂等键且指纹相同返回原结果；指纹不同返回冲突。

普通购买/续费产生一条 `CoinTransaction(type=PURCHASE, amount=-totalPrice, relatedID=order.id)`。零价永久选号、超级会员转永久和历史迁移不产生虚假的积分流水。

### User

保留：

- `accountId`
- `fancyNumber`

新增：

- `fancyNumberExpiresAt DateTime?`
- `fancyNumberPermanent Boolean @default(false)`

`FancyNumberLease` 是历史和归属真源，用户字段是兼容旧 API 和高频权限判断的当前快照。所有变更必须在同一事务内同步。

## HTTP API

### 用户接口

#### `GET /mall/fancy-numbers`

认证用户分页读取可购买号码。

查询参数：

- `cursor?: string`
- `limit?: number`，默认 20，最大 50

响应包含：

- `items`: 靓号 `id`、`value`
- `nextCursor`
- `unitPrice: 100`
- `minMonths: 1`
- `maxMonths: 12`
- `purchaseMode: "PAID_MONTHLY" | "PERMANENT_FREE"`

只返回 `AVAILABLE` 号码，不暴露持有人信息。

#### `GET /mall/fancy-numbers/me`

返回：

- `active`
- `accountId`
- `restoreAccountId`
- `startedAt`
- `expiresAt`
- `permanent`
- `renewable`
- `unitPrice`

没有租约时返回稳定的空状态，而不是 404。

#### `POST /mall/fancy-numbers/:id/purchase`

请求体：

- 普通用户：`months` 必填，整数 1–12；
- 超级会员：`months` 可省略，服务端始终按免费永久处理。

请求头必须包含非空 `Idempotency-Key`，并限制最大长度。

普通用户成功时扣 `months * 100` 积分。超级会员成功时价格为 0、租约永久。成功响应返回订单、当前账号、余额（零价时仍返回当前余额）、到期时间和永久标志。

#### `POST /mall/fancy-numbers/renew`

请求体 `months` 为整数 1–12，请求头必须包含 `Idempotency-Key`。

仅有效、非永久租约可续费。顺延基准是当前 `expiresAt`，不是请求时间。若服务发现租约已到期，会先安全完成到期恢复，然后返回“租约已到期，请重新购买”。

### 管理接口

- `GET /admin/mall/fancy-numbers`：按状态、号码关键字分页查询。
- `POST /admin/mall/fancy-numbers/batch`：批量录入并上架，单批最大 100 个。
- `PATCH /admin/mall/fancy-numbers/:id/status`：在 `AVAILABLE` 与 `DISABLED` 之间切换。

管理接口使用 `JwtGuard + AdminGuard`，并写入现有 `AdminAuditLog`。批量录入必须在写入前标准化、小写去重并校验：

- 账号格式；
- `AccountIdentifier` 是否已被账号、邀请码或其他库存占用；
- 请求内重复；
- 数据库并发唯一冲突。

管理端不能下架 `LEASED` 或 `PERMANENT` 号码。

## 核心流程

### 普通用户首购

在可串行化事务中：

1. 根据幂等键读取已有订单，校验请求指纹。
2. 锁定/读取用户、靓号、账号标识和钱包。
3. 若用户租约已到期但尚未清理，先执行到期恢复。
4. 校验用户为活动状态、没有其他有效租约、号码仍为 `AVAILABLE`。
5. 确认当前 `accountId` 的注册表记录归属于该用户。
6. 创建或取得钱包，以 `balance >= totalPrice` 条件原子扣款。
7. 创建租约和订单。
8. 将当前普通账号从 `currentUserID` 切到 `reservedForUserID`，将靓号标识切到 `currentUserID`。
9. 更新 `User.accountId`、`fancyNumber`、到期时间和永久标志。
10. 将库存状态改为 `LEASED`。
11. 写 `PURCHASE` 积分流水。

任何一步失败都会回滚，不出现“扣款成功但没拿到号”或“拿到号但没扣款”。

### 超级会员永久选号

流程与首购相同，但：

- 服务端依据有效会员等级 4 判定资格，不相信客户端字段；
- 不扣积分；
- `expiresAt=null`；
- `permanentAt=now`；
- 库存状态为 `PERMANENT`；
- 订单类型记录为零价 `PURCHASE`，用于审计但不写积分流水。

### 续费

在可串行化事务中：

1. 校验幂等键和请求指纹。
2. 锁定用户、有效租约和钱包。
3. 永久租约返回不可续费。
4. 到期租约先恢复，然后返回到期冲突。
5. 以当前到期时间调用现有 UTC 自然月算法顺延 1–12 个月。
6. 原子扣款，创建 `RENEWAL` 订单和 `PURCHASE` 流水。
7. 更新租约及用户快照到期时间。

不同幂等键的并发续费通过可串行化重试按顺序累加，不丢失月份；相同幂等键只扣一次。

### 升级超级会员

会员升级事务锁定用户后：

- 若没有有效付费租约，不创建或预占号码；
- 若有有效付费租约，将 `expiresAt` 清空、设置 `permanentAt`、更新用户永久标志和库存状态，并创建 `SUPER_CONVERSION` 零价订单；
- 已支付积分不退款；
- 重复会员升级或幂等重放不得重复创建转永久订单。

### 到期恢复

处理器分批找到 `endedAt IS NULL AND permanentAt IS NULL AND expiresAt <= now` 的租约。每条在事务内重新确认条件后：

1. 确认靓号仍是用户当前账号，原账号仍为本人保留。
2. 将靓号标识的 `currentUserID` 清空。
3. 将原账号从 `reservedForUserID` 恢复为 `currentUserID`。
4. 更新 `User.accountId`，清空到期时间和永久标志，设置 `fancyNumber=false`。
5. 关闭租约并记录 `EXPIRED`。
6. 将靓号状态改回 `AVAILABLE`。

条件已改变表示续费或永久化先提交，处理器跳过。发现注册表与租约不一致时不得猜测或覆盖账号，应记录结构化错误并让该条留待人工修复。

### 修改账号

`POST /auth/change-account-id` 在写入前：

- 检查是否存在有效或待清理租约；存在则拒绝；
- 通过 `AccountIdentifierModule` 取得新值；
- 同时检查账号、邀请码、原账号保留和靓号库存占用；
- 在事务内更新注册表和 `User.accountId`；
- 清理不再承担任何用途的旧普通标识。

所有创建用户的入口也必须在同一事务中登记标识，不能只更新主要注册接口。

## 会员目录兼容

- 钻石会员 `fancyNumberVoucher` 改为 `null`。
- 超级会员权益改为永久靓号语义；API 可将该字段扩展为 `permanent`，或增加明确的 `permanentFancyNumber=true`，实施时以保持现有响应字段兼容为优先。
- 停止创建新的 `STANDARD_FANCY_NUMBER` 和 `PREMIUM_FANCY_NUMBER` 权益发放记录。
- PostgreSQL 枚举值、旧 `MembershipBenefitGrant` 行和旧 DTO 兼容字段暂不删除。
- 旧记录只用于历史展示，不赋予新购买流程的兑换资格。

## 错误契约

为新增流程增加稳定业务错误码，至少覆盖：

- 靓号不存在或未上架；
- 靓号已被占用；
- 已持有有效靓号；
- 有效租约期间禁止改号；
- 余额不足；
- 月份范围非法；
- 租约不存在；
- 租约已到期；
- 永久靓号不可续费；
- 幂等键缺失、过长或与不同请求复用；
- 管理员录入号码与账号/邀请码/库存冲突；
- 出租中或永久号码不可下架。

唯一约束、局部唯一索引和序列化冲突必须映射为稳定的 409/业务错误，不能向客户端泄露 Prisma 错误。

## 安全与滥用防护

- 所有用户接口要求 JWT；写接口启用真正挂载的 `ThrottlerGuard`。
- 管理接口要求管理员守卫。
- 不信任客户端价格、会员等级、余额、到期时间或永久标志。
- 批量录入限制单批数量，列表使用有界分页。
- 日志只记录用户 UUID、订单 ID、号码记录 ID和错误码，不记录 JWT、请求体或敏感资料。
- 积分扣款不重试非幂等外部操作；本流程只有数据库事务，重试由幂等键和唯一约束保护。

## 事务后副作用与可观测性

事务提交后：

- 广播钱包余额变化；
- 失效用户资料摘要缓存并广播资料变化；
- 发送商城购买/到期系统通知（若产品需要）；
- 触发任何已有资料同步机制。

实时消息、缓存失效或通知失败不得回滚已提交交易。失败需要结构化警告并可安全重试。

记录低基数业务事件：

- `fancy_number_purchase_success`
- `fancy_number_renew_success`
- `fancy_number_expired`
- `fancy_number_converted_permanent`
- `fancy_number_admin_inventory_changed`

不把用户 ID、账号值或订单 ID作为 Prometheus label。

## 数据迁移与上线

1. 创建枚举、注册表、库存、租约和订单表及索引。
2. 回填所有现有 `accountId` 和 `inviteCode`。
3. 对跨列、跨用户冲突做迁移前检查；发现冲突时迁移失败并输出可定位记录，不能静默覆盖。
4. 为现有 `fancyNumber=true` 用户：
   - 将当前 `accountId` 建为库存记录；
   - 创建永久租约和 `LEGACY_GRANT` 零价订单；
   - 设置永久快照；
   - 不要求可恢复原账号，因为永久租约不会到期。
5. 增加用户快照字段和必要外键/检查约束。
6. 部署所有账号创建、改号、购买和到期路径统一使用注册表的代码。
7. 保留现有 `User.accountId` 唯一索引作为第二层防线。

测试数据库允许按上述规则直接迁移；未来生产上线前仍必须运行冲突预检。

## 测试策略

### 单元测试

- DTO：月份 1、12、0、13、小数；缺失/过长幂等键；非法靓号；批量上限。
- 自然月：月末、闰年、跨年。
- 普通首购：扣款、订单、租约、账号占用切换、用户快照和流水。
- 余额不足：所有业务写入均回滚。
- 续费：从现有到期时间顺延，不从当前时间重算。
- 超级会员：免费永久选择。
- 会员升级：有效付费租约转永久且不退款；幂等重放不重复写订单。
- 到期：恢复原账号、释放库存、关闭租约、取消权益。
- 修改账号：有效租约期间拒绝，普通流程正确迁移注册表占用。
- 管理接口：守卫、批量去重、冲突、上下架限制、审计。
- 会员详情：钻石无靓号券，超级显示永久靓号。

### 数据库并发与集成测试

- 两个用户同时购买同一号码，只有一个成功，失败方不扣款。
- 同一用户同时购买两个号码，最多一个成功。
- 相同幂等键并发重试只产生一个订单和一次扣款。
- 不同幂等键并发续费月份正确累加。
- 续费与到期处理并发只有一种一致结果。
- 其他用户改号与原账号恢复并发时，保留账号不可被抢。
- 多个到期处理器实例不会重复关闭租约。
- 数据库局部唯一索引、外键和迁移回填符合预期。

### 验证命令

先运行靓号、账号、积分、会员的目标测试，再运行：

- `npm run build`
- `npm run lint`
- `npm test`

由于改动涉及共享账号标识、钱包事务、会员状态、权限门槛、Prisma 模型和后台处理器，在合并前还应根据本地依赖可用性运行：

- `npm run test:e2e`
- `npm run test:redis`

本功能不改变 MinIO 流程，不强制运行 `npm run test:minio`，除非完整回归策略要求。

## 验收标准

- 普通用户能从管理员库存购买 1–12 个自然月并只扣一次正确积分。
- 用户能续费有效非永久靓号，到期时间按自然月正确顺延。
- 到期后原账号可靠恢复、靓号重新可购、靓号门槛立即失效。
- 超级会员能免费选一个永久靓号；已有租约升级后自动永久化。
- 有效租约期间不能修改账号，也不能持有第二个靓号。
- 原账号在整个租期内不能被其他注册、改号或库存录入流程占用。
- 所有并发和幂等测试证明不会双扣、双卖或丢失续费月份。
- 超级会员详情显示永久靓号，钻石会员不再获得靓号券。
