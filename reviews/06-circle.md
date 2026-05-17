# Phase 5 — Circle / Invitation / Plaza Review

> 范围:三个模块 ——
> - `src/circle/`(circle.module / controller / service / dto / spec):圈子 CRUD、加入/退出、活动
> - `src/circle-invitation/`:10 人验证邀请流程
> - `src/circle-plaza/`:广场发帖 / feed
> - `prisma/schema.prisma`:`Circle` / `CircleMember` / `CirclePost` / `CircleInvitation` / `CircleInvitationVerifier` / `CircleActivity` + 相关 enum
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **MED** | [circle-plaza.dto.ts:27-32](src/circle-plaza/dto/circle-plaza.dto.ts:27) `images` / [circle.dto.ts:58-61](src/circle/dto/circle.dto.ts:58) `avatarUrl` | 广场帖 `images[]` 与圈子 `avatarUrl` 都是**客户端任意字符串,无 URL / origin 校验**。广场 feed 对**所有登录用户**可见 → 帖子图片是直接的跨用户内容,可塞入攻击者域名(追踪像素 / 钓鱼)。比 note 4b#1 更严重(那个是 owner-private,这个一发即跨用户) |
| 2 | **MED** | [circle.dto.ts CreateCircleDto](src/circle/dto/circle.dto.ts:35) + [circle.service.ts:209](src/circle/circle.service.ts:209) | `CreateCircleDto` **没有 `isPublic` 字段** → 所有圈子恒为 `isPublic: true`(schema default)。`joinCircle` 的 `circle.isPublic ? 'ACTIVE' : 'PENDING'` 永远走 ACTIVE → **整条"私密圈 + PENDING 待审"代码路径是死的** |
| 3 | **MED** | circle 模块 | **没有删除圈子 / 转让 owner 的端点**。`leaveCircle` 对 owner 报 "transfer ownership first" 但**转让端点不存在**;`Circle.deleted` 字段从无人写入 → 圈子一旦创建永久存在,owner 被锁死 |
| 4 | **MED** | [circle-plaza.service.ts:93-144](src/circle-plaza/circle-plaza.service.ts:93) `getFeed` | feed **完全无成员资格过滤** —— 任意登录用户可读**任意圈子**的全部帖子(`vip/credit/fancy` 限制只影响 `canInteract` 布尔,不影响内容可见性)。若产品预期圈子帖有任何私密性,这是泄漏(需 confirm) |
| 5 | **MED** | [circle-plaza.service.ts:163-183](src/circle-plaza/circle-plaza.service.ts:163) `deletePost` | **只有作者能删帖**;圈子 owner / admin **无法移除**自己圈子里的违规帖 —— 无审核/治理路径 |
| 6 | **MED** | [circle-invitation.service.ts:52-63](src/circle-invitation/circle-invitation.service.ts:52) `invite` | `CircleInvitation` 无 `@@unique`;"无既有 PENDING 邀请" 用 `findFirst` 后 `create` —— TOCTOU,并发 invite 同一 applicant → 多条 PENDING 邀请 |
| 7 | **MED** | [circle-invitation.service.ts:393-442](src/circle-invitation/circle-invitation.service.ts:393) | `getMyPendingVerifications` / `getMyApplications` / `getPendingInvitationsForCircle` 都是 **N+1**:每个 invitation id 单独跑一次完整 `loadInvitation`(含 circle/applicant/inviter/verifiers) |
| 8 | **MED** | [schema.prisma CircleMember](prisma/schema.prisma#L1036) | `CircleMember.user` 是 `onDelete: Cascade` —— 用户注销时其 CircleMember 行被级联删,但 **`Circle.memberCount` 不会递减** → memberCount 随用户注销长期偏高漂移 |
| 9 | **MED** | [circle-plaza.dto.ts:21-25](src/circle-plaza/dto/circle-plaza.dto.ts:21) `content` 等 | 广场帖 `content`(5000)、圈子 `name`/`description`/`rules` 都无注入消毒,跨用户渲染;若前端按 HTML 渲染则 stored-XSS |
| 10 | LOW | 三个 controller | 全部 `@Req() req: any`(circle 8 + invitation 8 + plaza 3 ≈ 19 处) |
| 11 | LOW | [circle.dto.ts:108-114](src/circle/dto/circle.dto.ts:108) `maxMembers` | Swagger 标 `default: 500`,实际省略时 `createCircle` 写 `null`(无上限)—— 文档与行为不符 |
| 12 | LOW | [circle-plaza.service.ts:224](src/circle-plaza/circle-plaza.service.ts:224) `viewCount` | `CirclePost.viewCount` 只读从不写 —— 死字段 / 未实现 |
| 13 | LOW | [circle-invitation.service.ts:163](src/circle-invitation/circle-invitation.service.ts:163) | `addVerifier` 中文错误 "该好友不在本圈子" 暗示需好友关系,但逻辑只校验圈成员资格 |
| 14 | LOW | [circle.service.ts:197-244](src/circle/circle.service.ts:197) `joinCircle` | `existing` membership 在事务外读,事务内用;并发 join → `create` 命中 `CircleMember @@unique` 的 P2002(非 P2034,不重试)→ 裸 409 |
| 15 | LOW | [circle-plaza.service.ts createPost](src/circle-plaza/circle-plaza.service.ts:44) `noteId` | 帖子可嵌 `noteId`,但 `getNote` 是 owner-only → 其他圈成员**无任何接口能读到被嵌的 note** —— embed 对非作者不可用 |

共 **15 项**:HIGH 0、MED 9、LOW 6。

---

## 1. Circle 模块

### 1.1 `circle.module.ts` / `circle.controller.ts`
- module 正确 import `OpenimModule` ✓
- controller:类级 `@UseGuards(JwtGuard)` ✓;`ParseUUIDPipe` 全覆盖 ✓
- 路由顺序:`@Get('my')`(L62)先于 `@Get(':id')`(L72)✓;`@Get('activities/list')` / `activities/unread-count` 都是 2 段字面量,不与 `:id`(1 段)碰撞 ✓
- 全部 `@Req() req: any`(LOW-10)

### 1.2 `circle.service.ts`

**`createCircle` L31-100**
- VIP gate `vipLevel < 1` → 403 ✓
- 事务:create circle(`memberCount: 1`)+ create OWNER membership ✓
- 事务后 OpenIM `createGroup`,成功才写 `groupID`,失败仅 warn ✓ 非阻塞模式正确
- 🟠 **MED-2**:`CreateCircleDto` 无 `isPublic` → 恒 true
- 🟠 **MED-1**:`dto.avatarUrl` 直接落库,`@IsString` 无 origin 校验

**`listCircles` L102-133** — 分页 ✓,`deleted: false` 过滤 ✓
**`myCircles` L135-163** — tab joined/created/applied,OK
**`getCircleDetail` L165-183** — 任意登录用户可看任意圈详情(圈全公开,可接受)

**`joinCircle` L185-282**
- 圈存在 / maxMembers / `assertJoinRestrictions` / 既有 membership 检查
- `status = isPublic ? ACTIVE : PENDING` → 恒 ACTIVE(MED-2)
- ✅ **Serializable 事务 + P2034 重试 + 事务内重新校验 maxMembers** —— 并发扩员安全
- 🟡 LOW-14:`existing` 事务外读,并发 join 撞 P2002 → 裸 409

**`leaveCircle` L284-323**
- OWNER 不能离开 ✓;事务 delete membership + `wasActive` 时 decrement memberCount ✓
- 🟠 **MED-3**:报错让 owner "transfer ownership first" 但无转让端点;无删除圈端点

**`assertJoinRestrictions` L325-370** — vip/credit/fancy 三道门 ✓
**`getActivities` L381-414** — `viewerID` 范围 ✓,take 100 无分页(LOW)
**`markActivityRead` L423-428** — `updateMany` 按 viewerID 范围 ✓

### 1.3 `circle.dto.ts`
- `CreateCircleDto`:name/description/rules/tags/cities 长度与数量限制齐全 ✓
- **缺 `isPublic`**(MED-2);`avatarUrl` 无 `@IsUrl`(MED-1);`maxMembers` 文档默认 500 与实际 null 不符(LOW-11)

### Circle 模块 Verified OK
- `joinCircle` Serializable + 重试 + 事务内 capacity 重校验
- 计数器(memberCount)在正常路径事务保护
- OpenIM 调用非阻塞 + catch
- 路由顺序正确;全端点 JwtGuard

---

## 2. Circle-Invitation 模块

### 2.1 controller / dto
- 类级 JwtGuard ✓;`ParseUUIDPipe` 全覆盖 ✓
- 路由:`pending` / `my-applications`(1 段字面)先于 `:id`(1 段)✓;`circle/:circleId/pending`(3 段)无碰撞 ✓
- DTO 都是 UUID / boolean,OK

### 2.2 `circle-invitation.service.ts`

**`invite` L28-131**
- inviter 必须 ACTIVE 成员 ✓;applicant 非 ACTIVE 成员 ✓
- 🟠 **MED-6**:"无既有 PENDING" `findFirst` → `create` 是 TOCTOU
- circle 容量、applicant join 限制都校验 ✓
- 事务:create invitation(`approvedCount: 1`)+ create 首个 verifier(inviter, APPROVED)✓

**`addVerifier` L133-200**
- Serializable 事务 ✓;仅 applicant 可加 ✓;invitation 必须 PENDING ✓
- verifier 必须 ACTIVE 圈成员 ✓;重复 verifier 检查 ✓;`activeSlots >= requiredCount` 拒 ✓
- 创建 verifier PENDING + `VERIFICATION_REQUESTED` activity ✓
- LOW-13:错误文案 "好友" 与"圈成员"逻辑不一致

**`respond` L202-304**
- ✅ Serializable;找本人 PENDING verifier 记录;invitation PENDING 校验
- ✅ approve 路径:`updateMany({id,status:PENDING},{approvedCount:increment})` 原子计数 → 重查 → 达标则 `updateMany({id,status:PENDING},{status:APPROVED})` 原子状态机 → `admitApplicant` → activity
- ✅ reject 路径:仅置该 slot REJECTED,invitation 仍 PENDING,发 `INVITATION_SLOT_REJECTED`(applicant 可补加 verifier)
- OpenIM `syncApplicantToGroup` 在事务后 ✓
- **这段是整个 Phase 5 写得最扎实的** —— 原子计数 + 原子状态迁移 + 容量重校验

**`adminApprove` L306-375**
- caller 必须 ACTIVE OWNER/ADMIN ✓;Serializable finalize ADMIN_APPROVED → admitApplicant → activity ✓

**`getInvitationForViewer` / `assertCanViewInvitation` L377-384, L555-581**
- ✅ 授权完整:applicant / inviter / verifier / 圈 owner-admin 可看,其余 403

**`getMyPendingVerifications` / `getMyApplications` / `getPendingInvitationsForCircle` L393-442**
- 🟠 **MED-7**:`Promise.all(ids.map(fetchInvitationDto))` —— 每个 id 一次完整 `loadInvitation`,N+1

**`admitApplicant` L500-553** — 事务内 capacity 重校验 ✓;PENDING membership → ACTIVE ✓
**`runInvitationTransaction` L600-623** — Serializable + P2034 重试 ✓;末尾 `throw Unreachable` 是真正 unreachable 的防御 ✓

### Invitation 模块 Verified OK
- respond / adminApprove 全程 Serializable + 原子 `updateMany` 计数与状态机
- `assertCanViewInvitation` 授权严谨
- adminApprove 角色校验
- admitApplicant 事务内 capacity 重校验
- OpenIM 非阻塞

---

## 3. Circle-Plaza 模块

### 3.1 controller / dto
- 类级 JwtGuard ✓;`ParseUUIDPipe` 覆盖 ✓
- `CreatePlazaPostDto`:`content @MaxLength(5000)`、`images @ArrayMaxSize(9)`、`tags @ArrayMaxSize(5)`
  - 🟠 **MED-1**:`images` `@IsString({each})` —— 任意字符串 URL,无校验
  - 🟠 **MED-9**:`content` 无注入消毒;`city` 无长度上限(LOW)

### 3.2 `circle-plaza.service.ts`

**`createPost` L18-91**
- membership 必须 ACTIVE ✓;circle 未删 ✓;`memberCanPost` 检查(owner/admin 豁免)✓
- ✅ `noteId` 校验:必须是**本人拥有、available、未删**的 note —— 不能嵌别人的 note
- 事务:create post + `postCount` increment ✓
- 🟠 MED-1 `images` 任意 URL;🟠 MED-9 `content` 无消毒
- 🟡 LOW-15:`noteId` 嵌入后,`getNote` 是 owner-only → 其他圈成员读不到被嵌 note

**`getFeed` L93-144**
- 🟠 **MED-4**:`where: { status: ACTIVE, circle: { deleted: false } }` —— **无成员资格过滤**,任意用户读任意圈帖
- `checkCanInteract` 只算 `canInteract` 布尔,**不影响内容返回** —— vip 限制帖的正文非 vip 也能读(若产品意图是"限制互动非限制查看"则 OK,需 confirm)
- 分页 + `hasMore` ✓

**`getPost` L146-161** — 同 feed,无成员校验
**`deletePost` L163-183**
- 🟠 **MED-5**:仅作者可删;圈 owner/admin 无审核权
- 事务 soft-delete + `postCount` decrement ✓

**`checkCanInteract` L185-208** — vip/credit/fancy 门槛 ✓
**`toPlazaPostDto` L210-239** — `viewCount` 透传(LOW-12 死字段)

### Plaza 模块 Verified OK
- `createPost` 的 `noteId` 严格校验本人所有 + available
- membership ACTIVE 才能发帖;`memberCanPost` 尊重
- 计数器 postCount 事务保护
- feed 分页 + hasMore 完整

---

## 4. 修复建议(只列 MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 | 给 plaza `images` 与 circle `avatarUrl` 加 `MINIO_PUBLIC_URL` origin 校验(复用 note 模块刚加的 `assertMediaUrlsAreSafe` 思路);注入 ConfigService |
| #2 | `CreateCircleDto` 补 `isPublic?: boolean`(默认 true),`createCircle` 透传;否则删掉 `joinCircle` 里的私密分支与 invitation 流程的二义性 |
| #3 | 增加 `DELETE /circle/:id`(owner only,写 `deleted: true`)与 `POST /circle/:id/transfer-owner`;否则 `leaveCircle` 的报错文案要改 |
| #4 | confirm 产品意图:plaza feed 是否应只返回成员所在圈 + 公开圈;若是,加 membership 过滤 |
| #5 | `deletePost` 放开给圈 owner/admin(查 `circleMember` role);或加独立 moderation 端点 |
| #6 | `CircleInvitation` 加 partial unique 或 advisory lock(参考 friend `sendRequest` 的 `pg_advisory_xact_lock`)防并发重复 PENDING 邀请 |
| #7 | `getMy*` / `getPending*` 改成一次 `findMany` + `include`,消除 N+1 |
| #8 | 用户注销时同步递减相关 `Circle.memberCount`(在 user 删除流程里处理,或定期对账校正) |
| #9 | plaza `content` / circle 文本字段加注入消毒(与 friend evidence / coin message 同方案) |

---

## 5. Phase 5 总评

- **invitation 流程是亮点**:`respond` / `adminApprove` 全程 Serializable + 原子 `updateMany` 计数 + 原子状态机迁移 + 容量重校验 + 严谨的 `assertCanViewInvitation` —— 这是全项目并发处理最成熟的一段
- **circle 加入流程**也扎实(Serializable + 重试 + 事务内 capacity 重校验)
- **薄弱面**:
  - **内容信任边界**:plaza `images` / circle `avatarUrl` 是跨用户渲染的客户端任意 URL —— 比 note 4b#1 更危险,因为 plaza 一发即多人可见
  - **功能缺口**:私密圈不可建(`isPublic` 无入口)、圈不可删、owner 不可转、帖无审核 —— 一组"说了但没做"的能力
  - **N+1**:invitation 的三个 list 接口
  - **计数漂移**:用户注销不回补 memberCount
- **无 HIGH** —— 鉴权处处到位(invitation 授权尤其严谨),无金钱,无注入(Prisma 参数化);MED 集中在内容信任与功能完整性

> 与 Phase 4b 的联动确认:note 模块的媒体经 circle-plaza 暴露的担忧 —— **当前 plaza 帖虽存 `noteId`,但 `getNote` 是 owner-only,没有让非作者读到被嵌 note 的接口**(LOW-15)。所以 4b#1 的跨用户升级路径目前**尚未接通**;4b 已加的 `assertMediaUrlsAreSafe` 是有效的前置防御。

下一步:Phase 6 — Trace。
