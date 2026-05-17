# Phase 2b — Friend Aux Review

> 范围:`src/friend/` 中**好友请求生命周期以外**的部分:
> - `friend.service.ts`:`getFriendSettings`、`listActivities` / `getUnreadActivityCount` / `getActivity` / `markActivityRead`、`setRemark`、`listMyTags` / `createTag` / `deleteTag` / `assignTag` / `removeTag` / `listFriendsByTag`、`unblockUser` / `listBlocked`,以及私有 helper `syncPendingFriendTagLinks` / `promotePendingFriendTags` / `backfillLegacyActivitiesForViewer` / `getLegacyBackfillActivity` / `toFriendActivityDto`
> - `friend.controller.ts`:tags / remark / activities / blocked 路由
> - `friend.dto.ts`:tag / remark / activity / settings 相关 DTO
> - `friend.service.spec.ts`:与上述相关的 case
>
> 请求生命周期 / block / report 在 **Phase 2a**(`03a-friend-core.md`)。
> 颗粒度:逐文件逐行。行号基于 Phase 2a 修复后的当前文件(`friend.service.ts` 现 1208 行)。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **HIGH** | [friend.service.ts:553-575](src/friend/friend.service.ts:553) + [:998-1073](src/friend/friend.service.ts:998) | `listActivities` 与 `getUnreadActivityCount` **每次调用都跑 `backfillLegacyActivitiesForViewer`** — 一个 GET 端点在做写入(`createMany`),且对用户全部 Friend 行做无 `take` 的全扫。前端用 `getUnreadActivityCount` 做未读小红点轮询 → 每次轮询 2 个全表 scan + 潜在写。**与 2a #3/#16 同一根因,2b 视角强调:GET 副作用 + 轮询放大** |
| 2 | **MED** | [friend.service.ts:764-772](src/friend/friend.service.ts:764) `createTag` | **无每用户标签数量上限** — 用户可无限 `POST /tags` 制造 `FriendTag` 行 |
| 3 | **MED** | [friend.service.ts:764-772](src/friend/friend.service.ts:764) `createTag` | 端点名为 "Create a friend tag" 但实现是 `upsert(ownerID_name)` — 同名标签**静默更新 color**,不返回 409。客户端若按"创建"语义处理会困惑 |
| 4 | **MED** | [friend.service.ts:757-762](src/friend/friend.service.ts:757) `listMyTags` / [:842](src/friend/friend.service.ts:842) `listFriendsByTag` / [:713](src/friend/friend.service.ts:713) `listBlocked` / [:553](src/friend/friend.service.ts:553) `listActivities` | 全部**无分页**(与 2a #4 同类;activities 尤其会随时间无限增长) |
| 5 | **MED** | [friend.service.ts:1074-1150](src/friend/friend.service.ts:1074) `getLegacyBackfillActivity` | backfill **只为每个 legacy request 补一条** activity(state 决定的那一条)。一段已 ACCEPTED 的老好友关系,sender 的收件箱只会补出 `REQUEST_ACCEPTED_BY_OTHER`,丢失原始 `REQUEST_SENT` — 历史不完整(best-effort,但需明示) |
| 6 | **MED** | [friend.service.ts:998-1073](src/friend/friend.service.ts:998) backfill 并发 | 两个并发 `listActivities` 都算出"缺失" → 都 `createMany` → 重复 activity(`FriendActivity` 无 `@@unique`,`skipDuplicates` 无效)。与 2a #16 同 |
| 7 | LOW | [friend.controller.ts](src/friend/friend.controller.ts) `listTags` | 无返回类型注解、无 `@Serialize`,直接吐 Prisma 原始行(含 `createdAt`),与 `FriendTagDto`(无 `createdAt`)漂移 |
| 8 | LOW | [friend.service.ts:820-839](src/friend/friend.service.ts:820) `removeTag` vs [:784-817](src/friend/friend.service.ts:784) `assignTag` | `assignTag` 校验 `tag.ownerID` → 404;`removeTag` 不校验,靠 `deleteMany` 的 ownerID 过滤静默 no-op — 行为不一致 |
| 9 | LOW | [friend.service.ts:699-711](src/friend/friend.service.ts:699) `unblockUser` | find-then-delete 两次查询,可合并为单次 `delete` + catch P2025 → 404 |
| 10 | LOW | [friend.service.ts:478-502](src/friend/friend.service.ts:478) `getFriendSettings` + [:842](src/friend/friend.service.ts:842) `listFriendsByTag` | `friendsSince` / remark 取自 `Friend.updatedAt`,而 `setRemark` / accept 改 remark 也会动 `updatedAt` → "好友起始时间" 会漂移 |
| 11 | LOW | [friend.dto.ts CreateFriendTagDto](src/friend/dto/friend.dto.ts) | `name` 仅 `@IsString @MaxLength(30)`,无 `@IsNotEmpty` / 最小长度;`createTag` service 端 `trim()` + 空检查兜底(belt-and-braces,可接受) |
| 12 | LOW | [friend.service.ts:879-897](src/friend/friend.service.ts:879) `createFriendActivities` | `createMany` 无 `skipDuplicates`(其实无 `@@unique` 也无效,见 #6) |
| 13 | LOW | [friend.service.ts:593-608](src/friend/friend.service.ts:593) `markActivityRead` | 已读的 activity 再次标记 → `updateMany` count=0 → findFirst 找到 → 静默成功(幂等,OK,但调用方无法区分"刚标记"与"早已读") |
| 14 | LOW | `friend.service.spec.ts` | tag / remark / activity 读路径覆盖严重不足:`createTag` / `deleteTag` / `assignTag` / `removeTag` / `listMyTags` / `listFriendsByTag` / `setRemark` / `getActivity` / `getUnreadActivityCount` 均**无直接测试** |

共 **14 项**:HIGH 1、MED 5、LOW 8。(其中 #1/#6 与 2a 的 #3/#16 同根,本报告从 aux 视角补充细节)

---

## 1. File: `src/friend/friend.controller.ts` — Aux 路由

### Walkthrough
- **L114-128 `PATCH /:friendUserId/remark`** — `SetRemarkDto`,`dto.remark ?? null`(2a 已记:`{}` 也被当清空)
- **L204-209 `GET /activities`** — 返回 `FriendActivityDto[]`;**触发 backfill 写入**(#1)
- **L211-218 `GET /activities/unread-count`** — 同样触发 backfill;**前端轮询热点**(#1)
- **L220-228 `GET /activities/:activityId`** — `ParseUUIDPipe` ✓;不触发 backfill ✓
- **L230-239 `POST /activities/:activityId/read`** — `NO_CONTENT` ✓
- **L256-262 `GET /tags`** `listTags` — 无 `@Serialize`、无返回类型(#7)
- **L264-268 `POST /tags`** `createTag` — 无 `@HttpCode` → 默认 201 ✓;但语义是 upsert(#3)
- **L270-279 `DELETE /tags/:tagId`** — `ParseUUIDPipe` ✓ `NO_CONTENT` ✓
- **L281-295 `POST /:friendUserId/tags`** `assignTag` — `NO_CONTENT` ✓
- **L297-307 `DELETE /:friendUserId/tags/:tagId`** `removeTag` — 双 `ParseUUIDPipe` ✓
- **L309-317 `GET /tags/:tagId/friends`** `listFriendsByTag`
- **L340-344 `GET /blocked`** `listBlocked` — 无分页(#4)

### 路由顺序核对(Verified OK)
- `@Get('activities/unread-count')`(L211)声明在 `@Get('activities/:activityId')`(L220)**之前** → `/activities/unread-count` 命中字面路由,不会被 `:activityId` 吞掉 → 不会触发 `ParseUUIDPipe` 400 ✓
- `@Get('tags')` / `@Get('tags/:tagId/friends')` 与 `:friendUserId/settings`(2 段)段数不同,无碰撞 ✓
- 所有 aux 路由都被类级 `@UseGuards(JwtGuard)` 覆盖 ✓

### Findings
- [HIGH-1] L204, L211: GET 触发 backfill 写
- [LOW-7] L256-262: listTags 无序列化

### Verified OK
- 路由声明顺序正确(字面路由先于参数路由)
- 全部 aux 路由 JwtGuard 覆盖
- 所有路径参数 `ParseUUIDPipe`

---

## 2. File: `src/friend/friend.service.ts` — Aux 段

### 2.1 `getFriendSettings` L460-503
- L464-476 要求 ACCEPTED 友谊,否则 404 ✓
- L478-495 `Promise.all([friendTag.findMany, friendTagOnFriend.findMany({include:tag})])` 并发 ✓
- L497-502 `remark` 按 `friendship.userID === userId` 选 `remarkA`/`remarkB` ✓;`assignedTags` 返回完整 `FriendTag`(`ownerID` = 自己,无泄露)
- [LOW-10] remark 取自 record,展示 OK,但 `friendsSince` 概念在别处用 `updatedAt` — 见下

### 2.2 `listActivities` / `getUnreadActivityCount` L553-575 — 🔴 HIGH-1
- L554 / L568 都 `await this.backfillLegacyActivitiesForViewer(userId)` 打头
- **GET 端点在写库** — 非幂等、不可缓存;两个并发 GET → 双写(#6)
- `getUnreadActivityCount` 通常被前端定时轮询做小红点 → 每次轮询触发 backfill 全扫
- L556-560 `findMany({where:{viewerId}})` **无 take** — activity 表随时间无限增长,inbox 一次全量返回(#4)

### 2.3 `getActivity` L577-591
- `findFirst({id, viewerId})` — viewer 范围限定,**越权拿别人 activity 不可能** ✓
- 不存在 → 404 ✓

### 2.4 `markActivityRead` L593-608
- L594-597 `updateMany({id, viewerId, readAt:null})` — 原子标记 ✓
- L599-607 count=0 时回查存在性:不存在 → 404;存在(说明已读)→ 静默成功 ✓ 幂等
- [LOW-13] 已读再标记无法区分,产品上一般无所谓

### 2.5 `unblockUser` L699-711 / `listBlocked` L713-722
- unblockUser:find(L700)→ 不存在 404 → delete(L706)。[LOW-9] 两查可合一
- listBlocked:`findMany({blockerID})` + `include blocked` → map `{...blocked, blockedAt}`。无分页(#4)

### 2.6 `setRemark` L732-753
- L737-746 要求 ACCEPTED 友谊
- L748 `field = record.userID === userId ? 'remarkA' : 'remarkB'`
- L749-752 `update({ data: { [field]: remark } })` — 计算键写入 ✓
- remark 可为 `null`(清空),DTO `MaxLength(50)` ✓
- **副作用**:`update` 会触动 `Friend.updatedAt` → 影响 `listFriends` 的 `friendsSince` 排序与展示(LOW-10)

### 2.7 `listMyTags` L757-762
- `findMany({ownerID})` orderBy name。无分页(#4,低风险 — tag 数通常小,但配合 #2 无上限就有意义了)

### 2.8 `createTag` L764-772 — 🟠 MED-2 / MED-3
- L765-766 trim + 空检查 ✓(兜 DTO 没有的 `@IsNotEmpty`)
- L767-771 `upsert({ where: ownerID_name })`:
  - **MED-3**:同名 → 走 `update` 分支改 color,不报错。端点叫 "Create" 但行为是 "create or update"
  - **MED-2**:**没有"用户最多 N 个标签"的检查** — `create` 分支可无限触发
  - L769 `color: color ?? undefined` — 传 undefined 时保留原 color(re-create 不清空);语义对但未对客户端文档化

### 2.9 `deleteTag` L774-781
- findUnique + `tag.ownerID !== userId` → 404 ✓
- `friendTag.delete` — `FriendTagOnFriend.tag` 与 `PendingFriendTagOnRequest.tag` 都是 `onDelete: Cascade`(schema 已核实)→ 关联链干净级联删 ✓

### 2.10 `assignTag` L784-817
- L789-800 `Promise.all([friend.findFirst(ACCEPTED), friendTag.findUnique])` 并发 ✓
- L802-804 友谊不存在 404;tag 不存在或非本人 404 ✓
- L806-816 `friendTagOnFriend.upsert({ where: ownerID_tagID_friendID })` — 幂等 ✓

### 2.11 `removeTag` L820-839 — 🟡 LOW-8
- L825-834 要求 ACCEPTED 友谊
- L836-838 `deleteMany({ ownerID: userId, tagID, friendID })` — **不校验 tag 是否存在/属于自己**;ownerID 过滤保证不会误删他人链,但传错 tagId 是静默 no-op,而 `assignTag` 同场景会 404 → 两者不一致

### 2.12 `listFriendsByTag` L842-877
- L846-850 tag 所有权校验 ✓
- L852-855 取 links + `include friendship`
- L862-865 `user.findMany({status:'ACTIVE'})` — 同 2a MED-8,隐藏 inactive 朋友
- L868-876 拼装,`friendsSince: f.updatedAt`(LOW-10 漂移)
- 无分页(#4)

### 2.13 helper:`syncPendingFriendTagLinks` L930-951
- `deleteMany` then `createMany` — 在 sendRequest 事务内调用 ✓ 幂等

### 2.14 helper:`promotePendingFriendTags` L953-996
- L960-968 读 pending links
- L977-983 **重新校验 tag 仍存在**(owner 可能在 send→accept 之间删了 tag)✓ 这个防御很好
- L989-995 `friendTagOnFriend.createMany` — `FriendTagOnFriend @@unique([ownerID,tagID,friendID])` 保证无重复;handleRequest state-machine 保证不会重复 promote ✓

### 2.15 helper:`backfillLegacyActivitiesForViewer` L998-1073 — 🔴 HIGH-1 / MED-5/6
- L999-1010 `friend.findMany` OR(userID, friendID) 全状态 — **无 take**,全扫
- L1012-1018 `friendActivity.findMany` 取已存在的 → 建 `existingKeys` Set(`requestId:type`)
- L1020-1043 逐 request 算 `getLegacyBackfillActivity`,跳过已存在的,收集缺失
- L1045-1049 `createMany` 插入缺失
- **MED-5**:每个 request 只补**一条**(见 2.16),accepted 老关系丢 SENT
- **MED-6**:`existingKeys` 检查与 `createMany` 之间无锁/无 `@@unique` → 并发双写
- 设计应为:一次性迁移 + `User.activitiesBackfilledAt` 标志位(需 migration,见 2a #3)

### 2.16 helper:`getLegacyBackfillActivity` L1074-1150
- 纯函数:`(state, userID/friendID vs userId)` → 一条 activity 描述
- PENDING:sender→`REQUEST_SENT`,recipient→`REQUEST_RECEIVED`
- ACCEPTED:sender→`REQUEST_ACCEPTED_BY_OTHER`,recipient→`REQUEST_ACCEPTED_BY_ME`
- REJECTED:对称
- WITHDRAWN:仅 `friendID === userId`(recipient)得 `REQUEST_WITHDRAWN_BY_OTHER`;sender 不补(自己撤的)✓
- 逻辑正确,但**单条**语义即 MED-5 的根

### 2.17 helper:`toFriendActivityDto` L1152-1182
- 映射;`messageSnapshot ?? request.message` 兜底 ✓

### Findings(本文件)
- [HIGH-1] L553-575, L998-1073
- [MED-2/3] L764-772 createTag
- [MED-4] L553/L713/L757/L842 无分页
- [MED-5] L1074-1150 backfill 单条
- [MED-6] L998-1073 并发双写
- [LOW-8] L820-839 removeTag 不校验
- [LOW-9] L699-711 unblockUser 双查
- [LOW-10] updatedAt 漂移
- [LOW-12] L879-897 createMany 无 skipDuplicates
- [LOW-13] L593-608 markActivityRead 幂等无区分

### Verified OK
- `getActivity` viewerId 范围限定,无越权
- `markActivityRead` 用 `updateMany + count` 原子标记
- `deleteTag` 级联关系已核实(`PendingFriendTagOnRequest.tag` / `FriendTagOnFriend.tag` 均 Cascade)
- `promotePendingFriendTags` 在 promote 前重校验 tag 存在性
- `assignTag` / `friendTagOnFriend.upsert` 幂等
- tag / settings 返回不泄露他人 PII

---

## 3. File: `src/friend/dto/friend.dto.ts` — Aux DTO

- **L110-115 `FriendTagDto`** — `id/ownerID/name/color`;`ownerID` 是自己,无泄露;**缺 `createdAt`** 而 service 返回原始行带 `createdAt`(LOW-7)
- **L117-121 `FriendSettingsDto`** — `remark/assignedTags/availableTags`,OK
- **L144-175 `FriendActivity*Dto`** — `counterparty` 嵌套 DTO 化(比 `FriendRequestDto` 的 inline shape 好)✓
- **L177-186 `SetRemarkDto`** — `remark?: string | null` `MaxLength(50)` ✓
- **L188-201 `CreateFriendTagDto`** — `name @MaxLength(30)` 无 `@IsNotEmpty`(LOW-11);`color @IsHexColor` ✓
- **L203-207 `AssignTagDto`** — `tagId @IsUUID` ✓

### Findings
- [LOW-7] FriendTagDto 缺 createdAt
- [LOW-11] CreateFriendTagDto.name 无 IsNotEmpty

### Verified OK
- activity DTO 用嵌套 class(counterparty)
- 所有 input DTO 字段都有 class-validator

---

## 4. File: `src/friend/friend.service.spec.ts` — Aux 覆盖

### 已覆盖
- `getFriendSettings`(remark + assigned/available tags)✓
- `backfillLegacyActivitiesForViewer`(missing → 写入)✓ — 但没测"已存在 → 跳过"、没测并发
- `markActivityRead`(count=1 路径)✓

### 缺失(LOW-14)
- `createTag`:新建 / 同名 upsert / 空名拒绝
- `deleteTag`:成功 / 非本人 404
- `assignTag`:成功 / 友谊不存在 / tag 非本人
- `removeTag`:成功 / 无效 tagId 静默
- `listMyTags` / `listFriendsByTag`(含 inactive 过滤)
- `setRemark`:remarkA vs remarkB 选择 / 清空
- `getActivity`:越权(别人的 activityId)应 404
- `getUnreadActivityCount`
- `markActivityRead`:count=0 + 不存在 → 404;count=0 + 已读 → 静默成功

---

## 5. 修复建议(只列 HIGH/MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 / #6 | 加 `User.activitiesBackfilledAt: DateTime?`(migration),`backfill` 仅在该字段为 null 时跑一次并回填时间戳;迁移期过后整个 helper 降级为一次性脚本。GET 端点不再写库 |
| #2 | `createTag` 加每用户上限(如 `count >= 50` → `BadRequestException`),或在 schema 层不便约束就 service 层 count 检查 |
| #3 | 二选一:(a) 把端点语义明确为 `PUT /tags`(create-or-update),Swagger 文案改 "Create or update";(b) 改成纯 create,同名 → 显式 409 |
| #4 | activities / tags / blocked / listFriendsByTag 加 `take/skip` 或 cursor 分页(与 2a #4 一并做,需前端协调) |
| #5 | backfill 时为每个 request 补**全部应有的** activity(按 state 推导多条),或在 fixes 文档明确"legacy 仅补终态一条"的已知限制 |

---

## 6. Phase 2b 总评

- **tag / remark 子系统设计扎实**:owner 范围一致、`upsert` 幂等、`promotePendingFriendTags` 在 promote 前重校验 tag 存在性、级联删除关系正确 —— 这部分质量高于 core 段
- **activity 子系统的硬伤是 backfill**:把一次性数据迁移寄生在每个读请求(尤其是会被前端轮询的 unread-count)上,既是性能问题也是 GET 副作用反模式;并发下还会写重复数据
- **缺口集中在**:无分页(activity 会无限增长)、`createTag` 无数量上限 + 语义名实不符、tag 读路径测试几乎空白
- **2a 已修的 #13(pending tag 清理)** 让本阶段的 `syncPendingFriendTagLinks` / `promotePendingFriendTags` 生命周期闭环更完整

下一步:Phase 3 — Coin / 钱包(金钱 P0)。
