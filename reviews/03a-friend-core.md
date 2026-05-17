# Phase 2a — Friend Core Review

> 范围:`src/friend/` 中与好友请求生命周期 / 拉黑 / 举报 / 列表查询相关的部分:
> - `friend.module.ts`
> - `friend.controller.ts`(send/cancel/accept/reject/remove/block/unblock/report/listFriends/list*Requests/getStatus/getFriendSettings)
> - `friend.service.ts` L1–700(`sendRequest` / `cancelRequest` / `handleRequest` / `removeFriend` / `reportFriend` / `listFriends` / `listIncomingRequests` / `listOutgoingRequests` / `getStatus` / `getFriendSettings` / `blockUser` / `unblockUser` / `listBlocked`)
> - `friend.dto.ts` 请求 / 拉黑 / 举报相关 DTO
> - `friend.service.spec.ts` 与上述相关的 case
> - `prisma/schema.prisma` 的 `Friend` / `Block` / `FriendReport` 模型
>
> Tags / remarks / activities / backfill 路径在 **Phase 2b**。
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **HIGH** | [schema.prisma `model Friend`](prisma/schema.prisma#L320) + [friend.service.ts:188-194,879-886](src/friend/friend.service.ts:188) | `Friend` 模型**没有 `@@unique`**(只有 `@@index([userID])` / `@@index([friendID])`)。`sendRequest` 里 catch P2002 → "already pending / already friends" 的整段防御**永远不会触发** — 并发两次 sendRequest 会插入两条 PENDING 行,引出双重 friendship 状态机 |
| 2 | **HIGH** | [friend.service.ts:619-655](src/friend/friend.service.ts:619) `blockUser` | findUnique(already) → $transaction([deleteMany, create]) 之间存在 race;并发两次 block 调用 → 后到者命中 `Block.@@unique` 的 P2002 → 现状是直接抛 PrismaExceptionFilter 兜底的 409,但消息泄露 schema 字段名;另:**block 后未撤销 OpenIM 关系**(IM 通道仍可发消息) |
| 3 | **HIGH** | [friend.service.ts:956-1030](src/friend/friend.service.ts:956) `backfillLegacyActivitiesForViewer` | **每次 `listActivities` / `getUnreadActivityCount` 调用都跑一遍 backfill**(Friend.findMany + FriendActivity.findMany + 可能的 createMany)— 用户每次刷"消息中心"都触发数据迁移逻辑;1000 friends 的用户每次至少 2 个全表 scan |
| 4 | **HIGH** | [friend.service.ts:402-428](src/friend/friend.service.ts:402) `listFriends` 等 | **无分页**;`friendID/userID` 任一侧都可能 5000 条(MEMBER limit),响应一次性返回 5000 user 对象 + N+1 风格的 user.findMany |
| 5 | **HIGH** | [friend.service.ts:233-318](src/friend/friend.service.ts:233) `handleRequest` accept 路径 | **没有重检 sender 状态**:用户 A 发请求 → A 被封 → 用户 B 仍可 accept → 已封号用户得到一个活的 friendship |
| 6 | **MED** | [friend.service.ts:355-393](src/friend/friend.service.ts:355) `reportFriend` 去重 | `findFirst({reporterID,targetID,category})` 后 `create` — **TOCTOU**:两并发 report → 都通过去重 → 两条 report。schema 缺 `@@unique([reporterID,targetID,category])` |
| 7 | **MED** | [friend.service.ts:130-143](src/friend/friend.service.ts:130) `sendRequest` 的 tagIds | DTO 没限制 array 长度 → 客户端可送 10k 个 tagId,触发 `friendTag.findMany({id: in})` 全索引扫 + 数组比较 |
| 8 | **MED** | [friend.service.ts:411-417,488-489](src/friend/friend.service.ts:411) | listFriends/listIncoming/listOutgoing 用 `users.findMany({status: 'ACTIVE'})` + `.filter(userMap.has)` 隐藏 BANNED/DELETED 朋友 → 朋友计数(`assertBelowFriendLimit`)按 friend.count 含 deleted → **UI 显示 N-1,后端 quota 仍按 N 计**;且重新加该已删用户会被 `target.status !== ACTIVE` 拒 → 永远卡在"看到不了但占额度" |
| 9 | **MED** | [friend.dto.ts:84-95](src/friend/dto/friend.dto.ts:84) `ReportFriendDto.evidence` | `IsString({each:true})` + `MaxLength(500,{each:true})` 长度卡了,但**无 URL/objectKey 格式校验** → 用户可写 `<script>` 或 `https://攻击域名/...` 作为证据呈现给管理员 |
| 10 | **MED** | [friend.service.ts:130](src/friend/friend.service.ts:130) | 无单请求 tagIds 数量上限(DTO 与 service 都没)。安全 + 防 DoS 一并 |
| 11 | **MED** | [friend.service.ts:617-655](src/friend/friend.service.ts:617) `blockUser` | `$transaction([friend.deleteMany, block.create])` — `friend.deleteMany` 会**硬删所有状态的 Friend 行**(含 PENDING/REJECTED/WITHDRAWN/ACCEPTED 历史)。同时 `FriendActivity.onDelete:Cascade` → 双方收件箱里所有相关历史一夜消失;若产品想保留"我曾被你拒绝"的记录会丢 |
| 12 | **MED** | [friend.controller.ts](src/friend/friend.controller.ts) 15+ `@Req() req: any` | Phase 1 引入了 `RequestWithUser`,friend 模块没用上 |
| 13 | **MED** | [friend.service.ts:271-273](src/friend/friend.service.ts:271) `handleRequest` REJECT 分支 | accept 时 `promotePendingFriendTags` 把 pending tag 提升为 active;但**reject/cancel 时不清理** `pendingFriendTagOnRequest` 表 → 永久孤儿行(Friend 记录还在,关系链 onDelete:Cascade,但生命周期里没有清理点) |
| 14 | **MED** | [friend.service.ts:322-336](src/friend/friend.service.ts:322) `removeFriend` | 硬删 Friend → FriendActivity cascade 删 → 双方收件箱"我们曾经是朋友"全无;且**对端不收到任何通知/活动**(社交产品里这个反而是好行为,但与"删好友也写一条 activity" 的实现路线不一致)。**且**没有先校验对端 status — 即使对方已被封,你的 removeFriend 仍然成立(OK)但日志缺失 |
| 15 | **MED** | [friend.service.ts:1143-1165](src/friend/friend.service.ts:1143) `assertBelowFriendLimit` | `MEMBER` 提速比例硬编码;`role === 'MEMBER' \|\| 'ADMIN'` — **ADMIN 不应该按 user role 享受 MEMBER 上限**,这是把 admin 角色和付费等级混在一起;改用单独 `subscription` 字段更对 |
| 16 | **MED** | [friend.service.ts:155-187](src/friend/friend.service.ts:155) `sendRequest` 事务 | 事务里用 `tx: any`(类型擦除) — friend / friendTag / pendingFriendTagOnRequest / friendActivity 写,都靠 createMany 隐式幂等。**但 createFriendActivities 没设 `skipDuplicates`** → 罕见的 backfill+create 竞态会插重复 |
| 17 | LOW | [friend.dto.ts:47-51](src/friend/dto/friend.dto.ts:47) `HandleFriendRequestDto` | controller 用 `:requestId/accept` 与 `:requestId/reject` 两个独立路由,此 DTO 完全没用过 — 死代码 |
| 18 | LOW | [friend.controller.ts:23](src/friend/friend.controller.ts:23) | `import { FriendState } from 'src/generated/prisma'` 在 controller 直接 import 生成代码,controller 应该只用 service 暴露的领域类型 |
| 19 | LOW | [friend.service.ts:88-94, 624-630](src/friend/friend.service.ts:88) target 检查 | 三处独立的 "find target user + ACTIVE check" 逻辑(sendRequest / reportFriend / blockUser),没抽方法 |
| 20 | LOW | [friend.service.ts:97-107](src/friend/friend.service.ts:97) block 双向检查 | `OR: [...]` 全表 OR 查询,数据多时虽走 `@@index([blockerID])` + `@@index([blockedID])` 但 ORM 实际可能选其一退化到顺序扫;考虑两次 findUnique with composite key 更确定 |
| 21 | LOW | [friend.service.ts:110-125](src/friend/friend.service.ts:110) | "Already friends" vs "Friend request already pending" 通过查询双方向 `OR` 来判断,与 L189-194 的"假"死代码重复;两处合一 |
| 22 | LOW | [friend.service.ts:715-720](src/friend/friend.service.ts:715) `listMyTags` | 没分页;1000 个 tag 全返(理论上不太可能) |
| 23 | LOW | [friend.service.ts:475-521](src/friend/friend.service.ts:475) listIncoming/listOutgoing | 共 4 处 `users.findMany + Map + filter + map`,可抽 `attachUsers(records, fkKey)` |
| 24 | LOW | [friend.service.ts:580-615](src/friend/friend.service.ts:580) `getStatus` | 顺序两次 query;`Promise.all` 可并发 |
| 25 | LOW | [friend.service.ts:155-194](src/friend/friend.service.ts:155) | logger.log 信息含 `senderId → targetId`(全 UUID),没 PII,可保留;但缺 requestId,后期 debug 链接不上 |
| 26 | LOW | [friend.service.ts:84](src/friend/friend.service.ts:84) | 自交友消息硬编码英文,产品多语言时需要 i18n |
| 27 | LOW | [friend.dto.ts:98-108](src/friend/dto/friend.dto.ts:98) `FriendProfileDto` | 所有字段无 `@Expose`,如果未来加 `@Serialize` 会被全删 |
| 28 | LOW | [friend.service.spec.ts:284-358](src/friend/friend.service.spec.ts:284) "duplicate via P2002" 3 个 case | 测试在 mock 层伪造 P2002,与现实(无 @@unique → 不会抛)脱节 — 测的是不存在的代码路径 |
| 29 | LOW | [friend.service.spec.ts:917-955](src/friend/friend.service.spec.ts:917) backfill 测试 | 验证了"missing → 写入"但没验证"已存在 → 跳过";且没验证并发 backfill 的去重 |
| 30 | LOW | [friend.service.ts:155](src/friend/friend.service.ts:155) `as any` | requestData 类型断言 `as any` 用于绕开 Prisma 类型;实际可用 `Prisma.FriendCreateInput` |

共 **30 项**:HIGH 5、MED 11、LOW 14。

---

## 1. File: `src/friend/friend.module.ts` (10 lines)

### Walkthrough
- 标准 module,无 `@Global()`(对,只 controller 用)
- `exports: [FriendService]` 允许其它模块 inject(如 circle 邀请需检查好友关系)— 但目前没人 import friend module,export 是为未来准备

### Findings
无

### Verified OK
- 模块结构干净

---

## 2. File: `src/friend/friend.controller.ts` (345 lines)

### Walkthrough — 按路由分组

**L1–38 imports** — ok
**L40–45** 类装饰:`@ApiTags('Friend')` + `@ApiBearerAuth()` + **`@UseGuards(JwtGuard)`(类级)** + `@Controller('friend')` ✅

**L47–54 GET / (listFriends)**
- L52 `@Req() req: any` — LOW-12,改 `RequestWithUser`
- 返回 `Promise<FriendProfileDto[]>` — Swagger isArray 推断 OK
- 无 pagination — 见 HIGH-4

**L56–64 GET /:friendUserId/settings**
- `ParseUUIDPipe` ✅
- 同上 `@Req() req: any`

**L66–75 DELETE /:friendUserId (removeFriend)**
- `HttpStatus.NO_CONTENT` ✅
- 无 ownership check at controller(交给 service)— service 用 `OR` 双向查 + state=ACCEPTED,如果不存在抛 404 ✅

**L77–86 POST /:friendUserId/blacklist** —
- alias 走 `blockUser`,接收 UUID 路径参数
- **风险**:此路由与下方 L321 `POST /block` 重复语义 — 客户端用哪个?REST 一致性问题。LOW

**L88–97 DELETE /:friendUserId/blacklist** — 同上,alias 到 `unblockUser`

**L99–113 POST /:friendUserId/report**
- DTO `ReportFriendDto` 受 `forbidNonWhitelisted` 严格校验 ✅
- 路由是 `/friend/:id/report`,与 setup.ts L156-163 的 regex `/[^/]+/report$` 配对的 friendReportLimiter ✅
- **限制**:service 内强制 `friendship` 存在 → 只能举报朋友(产品决定)

**L115–131 PATCH /:friendUserId/remark**
- DTO `SetRemarkDto` 允许 `remark?: string | null`(传 null 清空)
- L129 `dto.remark ?? null` — 把 undefined 也变 null。如果客户端送 `{}` 也清空 remark(可能不是预期 — `{}` 应该是 noop)。LOW

**L133–150 POST /requests (sendRequest)**
- DTO `SendFriendRequestDto`,5 个字段(targetId / message / remark / tagIds)
- **没有客户端 idempotency-key 处理** — 网络重试同一笔会产生两条 PENDING 行(配合 HIGH-1 → 真的两条)
- 已有 friendRequestLimiter(30/15min/IP)

**L152–164 GET /requests/incoming/outgoing** — 无 pagination(HIGH-4)

**L166–179 POST /requests/:requestId/accept**, **L181–194 reject**, **L196–205 cancelRequest** — 走 service,均带 UUID 校验

**L207–242 GET /activities 系列** — 在 Phase 2b 详查 backfill 路径

**L246–253 GET /status/:targetId**
- 路径名 `status` 与 user.status 概念冲突,但走 friend 前缀,OK

**L256+** tags 与 block 系列 → 全部 Phase 2b 详细

### Findings
- [HIGH-4] L52, L155, L163: 列表无分页
- [MED-12] 全部 `@Req() req: any`
- [LOW-18] L23: controller 直接 import 生成 prisma 类型
- [LOW] L129: `?? null` 把 `{}` 当清空

### Verified OK
- 全部路由都被 JwtGuard 覆盖
- 所有路径参数都有 `ParseUUIDPipe`
- HttpStatus 标得对(NO_CONTENT for void)
- DTO 都接收 `@Body() dto: XxxDto` 强类型
- 走的是 service 抽象,无直接 prisma 调用

---

## 3. File: `src/friend/dto/friend.dto.ts` (208 lines)

### Walkthrough
- **L15–45 SendFriendRequestDto**
  - targetId UUID、message ≤ 200、remark ≤ 50、tagIds UUID v4 array + ArrayUnique
  - **缺 `@ArrayMaxSize(N)` on tagIds** — MED-10
- **L47–51 HandleFriendRequestDto** — 死代码(controller 用单独路由 accept/reject)— LOW-17
- **L53–57 BlockUserDto** — 仅 targetId,OK
- **L59–96 ReportFriendDto** — category enum、description ≤ 500、evidence ≤ 5 strings ≤ 500
  - L93 `IsString({each})` + L94 `MaxLength(500,{each})` — 类型与长度,但**没 URL / objectKey 格式校验**(MED-9)
- **L98–108 FriendProfileDto** — 仅 ApiProperty,无 class-validator(响应 DTO)
  - L107 `friendsSince: Date` 名字好,但来源是 Friend.updatedAt(remark/tag 改也会动)— UX 漂移风险(从 Phase 2b 看)
- **L110–115 FriendTagDto** — Phase 2b
- **L117–121 FriendSettingsDto** — Phase 2b
- **L123–134 FriendRequestDto** — inline `user: { id, accountId, nickname, avatarUrl }` shape,Swagger nested 文档不完整;LOW
- **L136–142 FriendStatusDto** — 5 状态枚举字符串,OK
- **L144–175 Activity / unread DTOs** — Phase 2b
- **L177–186 SetRemarkDto** — `remark?: string | null` 类型签名好,但 class-validator `@IsOptional` 不会拒 `null`(对) ✅
- **L188–201 CreateFriendTagDto / AssignTagDto** — Phase 2b

### Findings
- [MED-10] L44: tagIds 无 ArrayMaxSize
- [MED-9] L84-95: evidence 无 URL/格式约束
- [LOW-17] L47-51: HandleFriendRequestDto 死代码
- [LOW] L128-133: FriendRequestDto inline user shape

### Verified OK
- 所有 input DTO 字段都有 class-validator
- 长度限制覆盖 message/remark/description/evidence

---

## 4. File: `src/friend/friend.service.ts` — Core 段 L1–700

### 4.1 L1–72 imports / constants / ctor

- L21-23 `FRIEND_LIMIT_USER=1_000`, `FRIEND_LIMIT_MEMBER=5_000` — 硬编码 magic number;应 env 化(LOW)
- L26-31 `MINI_USER_SELECT` 只 4 字段,OK,无 PII
- L34-42 `FRIEND_PROFILE_SELECT` — 7 字段,OK
- L44-66 activity 常量与类型 — Phase 2b
- L68-72 service ctor:仅 `prisma`,没有 `OpenimService` / 通知服务注入 → 状态变更**完全不触发 IM 通道**(用户加好友后,IM 那边还看不到对方,等到 OpenIM 自己同步)

### 4.2 L76–197 `sendRequest`(74 行)

逐段:
- L83-85 自加判定 ✅
- L88-94 target 必须 ACTIVE — 但**没区分 NOT_FOUND vs INACTIVE**,与 auth login 同 oracle 风险一致(MED,但比 login 弱:只暴露给已登录用户)
- L97-107 双向 block 检查 — 一次 findFirst,OK
- L110-125 双向 PENDING/ACCEPTED 检查 — **核心去重**,但**先做 SELECT 再 INSERT**,中间无锁,**TOCTOU 在没有 @@unique 的情况下放任并发产生两条 PENDING**(HIGH-1)
- L128 assertBelowFriendLimit — sender 配额检查 ✅
- L130-143 tagIds 归一化 + 所有权校验 ✅
- L146-152 requestData 用 `as any` 类型断言(LOW-30)
- L154-194 transaction 内:create Friend + sync pending tag links + create 2 activities(mirror)
- L188-194 try/catch:isPrismaUniqueConstraintError 路径 — **HIGH-1 死代码**
- L196 logger.log,无 requestId

**HIGH-1 复现路径**:
```
T0: 用户 A 与 B 都无好友关系
T1: A 客户端点击"加好友"两次(双击) → 两个并发 sendRequest
T2: 两个请求都通过 L110-125 检查(都看不到对方的 PENDING)
T3: 两条 INSERT 都成功(无 @@unique 拦)→ DB 有 2 条 PENDING (A→B)
T4: B 看到一封请求(后端某一查询返回 first 或 distinct 后只剩一封)
T5: B accept → handleRequest 把 request_id_1 改 ACCEPTED;request_id_2 仍 PENDING
T6: A 看 outgoing 列表 → 一条 ACCEPTED 一条 PENDING (与同一人)
T7: assertBelowFriendLimit count ACCEPTED → 计 1,但 PENDING 那条永远卡着
T8: A 试图 cancel request_id_2 → service 允许(senderId 匹配,state PENDING)
T9: B 收到 "REQUEST_WITHDRAWN_BY_OTHER" activity → 困惑
```

修复:`schema.prisma model Friend` 加部分唯一约束或 sentinel:
```
// Partial unique on currently-active relationships
@@unique([userID, friendID, state]) // 但 state 变会触发新一行的唯一约束 — 太严
```
更好:用 db trigger 或 application-level lock(Redis `SETNX friend:lock:{min(a,b)}:{max(a,b)}`)

### 4.3 L201–229 `cancelRequest`(28 行)

- L202-211 findUnique + 三重检查(存在、senderId 匹配、PENDING) — ✅
- L212-228 transaction:update Friend + 1 activity(给 recipient)
- 没有撤回时间窗(发出后 5 秒不能撤?可加防恶意)— LOW

### 4.4 L233–318 `handleRequest`(85 行)

- L238-246 同样三重检查(record 存在、friendID === recipientId、state PENDING)— ✅
- L249-252 仅 ACCEPTED 才检 recipient 配额(reject 不占)— ✅
- L254-317 transaction:
  - L257-264 仅 ACCEPTED 才用 pendingRemarkBySender 写到 remarkA ✅
  - L266-269 update Friend state
  - L271-273 仅 ACCEPTED → promotePendingFriendTags ✅
  - L275-313 写双向 4 条 activity(accept) 或 2 条(reject)
- 🔴 **HIGH-5**:**accept 时不检 sender(`record.userID`)的 status** — sender 可能已被封,你接受了一个"幽灵好友"
- 🟡 MED-13:reject 路径不清理 `pendingFriendTagOnRequest` 表 → 孤儿行
- 🟡 MED-16:`createFriendActivities` 用 `createMany`,无 `skipDuplicates`;backfill 并发可造重复
- L259-262 `record.pendingRemarkBySender !== null && !== undefined` — 可简化为 `!= null`,语义同(`!=` 同时检查 null/undefined)。LOW

### 4.5 L322–336 `removeFriend`(15 行)

- L323-331 双向查 + state=ACCEPTED ✅
- L335 `prisma.friend.delete`(硬删)
- 🟡 MED-14:没 activity 通知双方;没检对端 status

### 4.6 L338–398 `reportFriend`(61 行)

- L343-345 自报判定 ✅
- L347-353 target ACTIVE 检查 ✅
- L355-367 必须存在 ACCEPTED 友谊(产品决定:只能举报朋友)
- L369-383 dedupe via findFirst — **TOCTOU**(MED-6)
- L385-393 create FriendReport
- L395-397 warn 日志(reporterId / targetId / category)
- 没把 reportId 返给 controller — 客户端无法追踪(LOW)

### 4.7 L402–428 `listFriends`(27 行)

- L403-409 取所有 ACCEPTED 行
- L411-413 提对端 id 列表
- L414-417 user.findMany({status: ACTIVE}) — **隐过滤 deleted 朋友**
- L418 Map
- L420-427 拼装 — 跳过 map miss 的(即对端已删/非 active)
- 🔴 HIGH-4:无分页;5000 朋友 → 5000 行 + 5000 user 行响应
- 🟠 MED-8:filter 后用户看不到的朋友仍占 `assertBelowFriendLimit` 的 count

### 4.8 L430–473 `getFriendSettings`(44 行)

- 走的是 `Promise.all([friendTag.findMany, friendTagOnFriend.findMany({include:tag})])` — 并发 ✅
- L468-470 `remarkA` vs `remarkB` 选哪个看 userId 与 friendship.userID 对齐 ✅
- 详细看 Phase 2b

### 4.9 L475–521 `listIncomingRequests/listOutgoingRequests`(47 行)

- 重复结构(MINI_USER_SELECT + filter)
- 同 HIGH-4 无分页
- 同 MED-8 inactive 朋友过滤

### 4.10 L580–615 `getStatus`(36 行)

- L587-597 block 优先返回 'BLOCKED'
- L599-614 friend 查 PENDING/ACCEPTED
- ✅ 五状态枚举严格
- LOW-24:两次顺序 query,可并发

### 4.11 L617–680 `blockUser` / `unblockUser` / `listBlocked`

- **blockUser**:
  - L632-637 findUnique already → ConflictException
  - L640-652 $transaction([friend.deleteMany OR(双向所有 state), block.create])
  - 🔴 HIGH-2:findUnique 与 create 之间 race(MED 实际上,但 PrismaExceptionFilter 把 P2002 转 409 后行为"似乎"OK — 只是错误消息不友好)
  - 🟡 MED-11:friend.deleteMany 删所有 state 的行(含 PENDING/REJECTED/WITHDRAWN 历史)+ FriendActivity 级联 → 一锅端
  - 🔴 HIGH-2(后半):无 IM 关系撤销
- **unblockUser**:
  - L658-668 find then delete(可一步 delete + P2025 → 404)— LOW-28
- **listBlocked**:
  - L671-680 全量(无分页)— LOW

---

## 5. File: `src/friend/friend.service.spec.ts` — Core 段相关

### Walkthrough(已读 L1–460,与 core 段相关)

- **mocks(L18-71)**:每个 prisma 子方法完整列出,但很多 method 实际可去掉(test 没用)
- **L99-108 blockUser 缺 user**:覆盖 404 不进事务 ✅
- **L110-150 sendRequest mirror activities**:OK ✅
- **L186-228 sendRequest with remark + tags**:✅
- **L230-282 retry after rejection 走 fresh request**:验证 reject 后再发是新行
- **L284-358 P2002 三个 case**:
  - 🔴 **LOW-28**:**测的是死代码路径** — schema 无 @@unique,P2002 不会发生。这 3 个 case 都是 mock 强制抛 P2002
  - 但有用作 documentation(若以后加 @@unique 就需要这些)
- **L361-404 transaction atomicity**:验证 activity createMany 失败时 transaction 回滚(没在 prisma 真实层验证)
- **L406-435 explicit sender remark not fallback to message**:✅
- **L437-459 reject tag not owned by sender**:✅
- **L461-484 controller dto pass-through**:验证 controller → service ✅
- **L486-622 reportFriend 系列**:5 case(self-report、active friendship report、dupe、non-friend、controller pass-through、block routes)✅
- **L624-704 cancelRequest atomicity**:✅
- **L706-892 handleRequest 系列**:accept with remark/tags、 transaction atomicity、reject 不应用 metadata ✅
- **L894-955 markActivityRead / backfillLegacy**:Phase 2b
- **L957-968 dto sender remark + tag validation**:✅

### Findings
- [LOW-28] L284-358: 测试不存在的代码路径(P2002)
- [LOW] 缺测试:
  - sendRequest 并发产生两条 PENDING 行(需 fake clock + concurrent mock)
  - removeFriend 后再 sendRequest 应当成功
  - blockUser 后 sender + recipient 的 sendRequest 都被拒
  - banned sender 的请求被 recipient accept 应当拒(HIGH-5 covers)
  - reportFriend dedupe TOCTOU(需 race mock)

### Verified OK
- Coverage 已较高(请求生命周期主要节点都被覆盖)
- 多次验证"transaction 内的 activity createMany 失败 → 全回滚"(防止半写)
- 区分了 sender remark explicit / fallback / undefined
- block 失败前置检查到位

---

## 6. File: `src/friend/dto/friend.dto.spec.ts` (32 lines)

- 2 case:SendFriendRequestDto.message 超长被拒 / ReportFriendDto.description 与 evidence count 超限被拒
- **缺**:
  - tagIds 含非 UUID 被拒
  - tagIds 非 array 类型被拒
  - evidence 项含 `<script>` / `javascript:` 仍通过(因为 IsString 而非 IsUrl)
  - report category 非枚举值被拒
  - description 全空字符串被拒(`@IsNotEmpty` 已覆盖)

---

## 7. 修复建议(只列 HIGH/MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 | schema.prisma `model Friend`:加 partial unique 或 application 锁。最简方案:Redis SETNX 或 advisory lock `pg_try_advisory_xact_lock(hashtext(min:max))` 在 sendRequest 事务开头。完整方案:加迁移 `@@unique([userID, friendID], where: { state: 'PENDING' })`(Prisma 支持 partial unique via raw SQL) |
| #2 | blockUser:用 `prisma.block.upsert({where: composite, create: {...}, update: {}})` 替代 find+create;若产品要 OpenIM 关系撤销,引入 `openim.removeFriendship` 调用(放事务后非阻塞) |
| #3 | backfill:加 `User.activitiesBackfilledAt: DateTime?`,只在首次为 null 时跑一次;迁移完成后整段代码可拆为后台 job |
| #4 | 给 listFriends/listIncoming/listOutgoing/listBlocked 加 `take/skip` + `cursor` 分页;DTO 加 `@Max(100)` |
| #5 | handleRequest accept 分支加 `if (sender.status !== 'ACTIVE') throw ForbiddenException('Sender is not active')` |
| #6 | schema FriendReport 加 `@@unique([reporterID, targetID, category])`;service dedupe 改 `try create + catch P2002` |
| #7 / #10 | SendFriendRequestDto.tagIds 加 `@ArrayMaxSize(20)` |
| #8 | listFriends 等三处:把 active filter 改成只在响应层标记 `counterpartyActive: false`,counter 与 visible 一致;或同步把 inactive 朋友的 Friend 行 archive |
| #9 | ReportFriendDto.evidence:改 `@IsUrl({each: true})` 或自定义 `@IsObjectKey({each: true})` 装饰器(校验是 MINIO_PUBLIC_URL 前缀 + 路径) |
| #11 | blockUser:把 friend.deleteMany 改为只删 ACCEPTED + PENDING(保留 REJECTED/WITHDRAWN 历史);或加 `archivedAt` 软删字段不真删 |
| #12 | 4 处 friend controller `@Req() req: any` → `RequestWithUser` |
| #13 | handleRequest reject/cancel 路径调用 `tx.pendingFriendTagOnRequest.deleteMany({where: { requestID }})` |
| #14 | removeFriend 加 `friend.findFirst({include:friend})` 取对端 user;若需要通知,事务内写一条 activity |
| #15 | assertBelowFriendLimit 改 `role === 'MEMBER'` 而不带 ADMIN;ADMIN 走独立的 `bypassFriendLimit` flag |
| #16 | createFriendActivities 加 `skipDuplicates: true`;并发安全 |

---

## 8. Phase 2a 总评

- **整体框架对**:5 状态 enum 干净,activity 镜像写入对(viewer/actor/counterparty 三元组合理),tag 提升机制(pending → active on accept)思路好
- **薄弱面**:
  - **DB 约束缺失**(Friend 无 @@unique,FriendReport 无 dedupe @@unique)— 业务防御靠应用层 SELECT-then-INSERT 这种 TOCTOU 模式,生产并发下会失效
  - **没有分页** — 上限内仍可拉 5000 行响应
  - **状态变更与 IM 无联动**(block 不撤 IM 关系,sender 被封后 recipient 还能 accept)
  - **backfill 寄生在读路径上** — 每次刷消息中心都跑迁移逻辑
- **测试覆盖看似完整,实际有空洞**:大量测试在 mock 层伪造 P2002,覆盖了不存在的代码路径;缺乏并发场景、edge case 的负面用例

下一步:Phase 2b — Friend Aux(tags / remarks / activities / backfill 细节)。
