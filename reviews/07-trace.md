# Phase 6 — Trace (Moments) Review

> 范围:`src/trace/` 全部(`trace.module.ts` / `trace.controller.ts` / `trace.service.ts` / `dto/trace.dto.ts` / `trace.service.spec.ts`)+ `prisma/schema.prisma` 的 `Trace` / `TraceComment` / `traceLikeStat` / `traceViewedStat` / `UserTracePreference` + 相关 enum。
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **MED** | [trace.service.ts:171-210](src/trace/trace.service.ts:171) `toggleLike` | `findFirst` 在事务**外**读 `existing`,再进事务盲目 `likeCount {increment}`。两个并发 toggle 都读到同一 `deleted` 值 → 各自 `+1` → **`likeCount` 漂移 +2**(逻辑上只点了一次)。`traceLikeStat.deleted` 最终值对,但计数错 |
| 2 | **MED** | [trace.service.ts:368-370](src/trace/trace.service.ts:368) `toTraceDto` `isLikedByMe` | `isLikedByMe` 从 `likeStats`(feed query 里 `take: 20`,按 `updatedAt desc`)里 `.some()` 算。一条 trace 点赞 >20 人、且**查看者自己的赞不在最近 20 个里** → `isLikedByMe` 误判为 `false` |
| 3 | **MED** | [trace.service.ts:171-210](src/trace/trace.service.ts:171) `toggleLike` 新赞分支 | 新赞走 `findFirst` → `create`(无事务前锁)。双击 → 并发两个 `create` → 第二个命中 `traceLikeStat @@unique([traceID,userID])` 的 P2002 → 裸 409。`@@unique` 保住了 `likeCount` 不被双增(整批失败),但用户体验是丑陋的 409 而非幂等 |
| 4 | **MED** | [trace.service.ts:122-153](src/trace/trace.service.ts:122) `createTrace` `images` | trace `images[]` 是客户端任意字符串 URL,无 origin 校验;moment 对好友可见 → 跨用户 off-origin 追踪/钓鱼面(与 note 4b#1 / plaza 5#1 同类,**应复用刚抽出的 `assertUrlsFromStorage`**) |
| 5 | **MED** | `UserTracePreference`(HIDE)整体 | schema 有 `UserTracePreference` + `HIDE` 枚举,但 `getFeed` **从不按它过滤**,controller 也**没有"隐藏某条 moment"的端点** → 整个"隐藏"功能是死的 |
| 6 | LOW | [trace.dto.ts:18,36-39](src/trace/dto/trace.dto.ts:18) + feed query | `TraceVisibility` 枚举含 `PUBLIC`,`getFeed` 的 `where.OR` 也含 `PUBLIC`,但 `CreateTraceDto` 只允许 `FRIENDS_ONLY`/`PRIVATE` → **PUBLIC 永远造不出来**,feed 里那段是死路径 |
| 7 | LOW | [trace.controller.ts](src/trace/trace.controller.ts) | 7 处 `@Req() req: any` —— 应用 `RequestWithUser` |
| 8 | LOW | schema `Trace` / `TraceComment` | 死字段:`Trace.title` / `latitude` / `longitude` / `viewCount`、`traceViewedStat` 模型、`TraceComment.images` —— 均无 DTO 入口、无代码写入 |
| 9 | LOW | [trace.service.ts:155-167](src/trace/trace.service.ts:155) `deleteTrace` | `trace.update` 的 where 只有 `{ id }`,与 note 模块特意加的 `ownerID + 状态` TOCTOU 守卫不一致 |
| 10 | LOW | [trace.service.ts:275-294](src/trace/trace.service.ts:275) `deleteComment` | 软删评论不处理子回复 —— 子回复的 `replyTo` 仍指向已软删的父评论,feed 里 `replyTo` include 不过滤 `deleted` → 显示"回复 <已删评论>" |

共 **10 项**:HIGH 0、MED 5、LOW 5。

---

## 1. File: `src/trace/trace.module.ts` (9 lines)
标准 module,无 `exports`(无人依赖)。**OK**。

## 2. File: `src/trace/trace.controller.ts` (109 lines)

### Walkthrough
- L33-36 类装饰:`@ApiTags` + `@ApiBearerAuth` + **`@UseGuards(JwtGuard)`(类级)** + `@Controller('trace')` ✓
- L40-47 `GET /trace/feed` — `@Query TraceFeedQueryDto`
- L49-56 `GET /trace/feed/new-count` — 声明在 `feed` 之后,2 段字面路由,不与 `:id` 碰撞 ✓
- L58-66 `POST /trace` — `CreateTraceDto`
- L68-77 `DELETE /trace/:id` — `ParseUUIDPipe` ✓
- L79-86 `POST /trace/:id/like`
- L88-97 `POST /trace/:id/comment`
- L99-108 `DELETE /trace/comment/:commentId` — 2 段,声明在 `:id`(1 段)之后,无碰撞 ✓
- 全部 `@Req() req: any`(LOW-7)

### Verified OK
- 类级 JwtGuard;所有路径参数 `ParseUUIDPipe`;路由顺序无碰撞

## 3. File: `src/trace/dto/trace.dto.ts` (106 lines)

- `CreateTraceDto`:`content @MaxLength(5000)`、`images @IsString({each}) @ArrayMaxSize(9)`(MED-4 无 origin 校验)、`visibility` 限 `FRIENDS_ONLY`/`PRIVATE`(MED-6:无 PUBLIC)
- `CreateTraceCommentDto`:`content @MaxLength(1000)`、`replyToId @IsUUID`;**无 `images` 字段**(LOW-8 schema 有)
- `TraceFeedQueryDto`:分页 `@Min(1) @Max(100)` ✓
- `NewCountQueryDto`:`since @IsISO8601` ✓

---

## 4. File: `src/trace/trace.service.ts` (390 lines)

### 4.1 `getFeed` L25-95
- `getAcceptedFriendIds` → `visibleUserIds = [self, ...friends]`
- `where`:`deleted:false` + `fromID IN visibleUserIds` + `OR[fromID===self, FRIENDS_ONLY, PUBLIC]`
- ✅ **可见性逻辑正确**:好友的 PRIVATE 被排除(OR 三项都不命中),自己的 PRIVATE 被 `fromID===self` 放行
- include:`likeStats`(`take:20`)、`comments`(`take:20`)
- 🟠 **不按 `UserTracePreference` 过滤**(MED-5)
- 分页 + `hasMore` ✓

### 4.2 `getNewCount` L97-118
- `new Date(since)` + `Number.isNaN` 校验 ✓;可见性同 feed ✓

### 4.3 `createTrace` L122-153
- `visibility: dto.visibility ?? 'FRIENDS_ONLY'`
- 🟠 MED-4:`images` 无 origin 校验
- LOW-8:`title` / `latitude` / `longitude` schema 有,DTO 无 → 恒默认值

### 4.4 `deleteTrace` L155-167
- findFirst + 作者校验 + 软删 `deleted:true`
- 🟡 LOW-9:`update` where 只 `{id}`

### 4.5 `toggleLike` L171-210 — 🟠 MED-1 / MED-3
- L175 `requireVisibleTrace` ✓
- L177-179 `traceLikeStat.findFirst({traceID,userID})` —— **事务外读**
- L181-197 existing 分支:`$transaction([likeStat.update(deleted翻转), trace.update(likeCount±1)])`
  - 🟠 **MED-1**:两个并发 toggle 读到同一 `existing.deleted` → 都执行 `increment` → `likeCount` 漂移
- L199-207 新赞分支:`$transaction([likeStat.create, trace.update(likeCount+1)])`
  - 🟠 **MED-3**:并发双击 → 第二个 `create` 撞 `@@unique` P2002 → 裸 409(但 `likeCount` 因整批失败而**不会**双增 ✓)
- 返回的 `likeCount` 是 `trace.likeCount`(事务前的值)± 1 —— 在 MED-1 漂移下也不准

### 4.6 `addComment` L214-273
- `requireVisibleTrace` ✓;`replyToId` 校验存在 + 同 trace ✓
- 事务:`traceComment.create` + `trace.replyCount {increment}` ✓ 原子
- `parentID = replyToID`(扁平模型,可接受)

### 4.7 `deleteComment` L275-294
- 作者校验 + 软删 + `replyCount {decrement}` ✓ 原子
- 🟡 LOW-10:不处理子回复

### 4.8 `requireVisibleTrace` L309-327
- ✅ **授权正确**:PUBLIC / 自己 / FRIENDS_ONLY+好友 放行,PRIVATE 非作者 → 403

### 4.9 `toTraceDto` L329-389
- ✅ 互为好友过滤(likes/comments 仅展示与查看者互为好友者)—— WeChat Moments 语义正确
- 🟠 **MED-2**:`isLikedByMe` 从 `take:20` 的 `likeStats` 算 → 截断误判

### Findings
- [MED-1] L181-197 toggleLike 并发计数漂移
- [MED-2] L368 isLikedByMe 截断误判
- [MED-3] L199-207 toggleLike 双击裸 409
- [MED-4] L126 images 无 origin 校验
- [MED-5] UserTracePreference 死功能
- [LOW-6] PUBLIC 不可创建
- [LOW-9] deleteTrace where 不一致
- [LOW-10] deleteComment 不处理子回复

### Verified OK ✅
- `requireVisibleTrace` 三态授权正确
- feed `where` 可见性逻辑正确(好友 PRIVATE 排除)
- `toTraceDto` 互为好友过滤符合 WeChat 语义
- `replyCount` 增减原子(事务内)
- `traceLikeStat @@unique` 防住了并发新赞的 `likeCount` 双增
- 分页 + hasMore
- comment replyTo 同 trace 校验
- 类级 JwtGuard;ParseUUIDPipe;路由顺序无碰撞
- `getNewCount` 校验时间戳

---

## 5. File: `src/trace/trace.service.spec.ts` (105 lines)
- 3 个测试:私密 trace 点赞被拒、跨 trace 回复被拒、feed 截断 likes/comments
- **缺口**:`toggleLike` happy path(尤其是 MED-1 并发漂移)、`isLikedByMe` 截断场景、`createTrace`、`deleteTrace` 作者校验、`addComment` happy、`getFeed` 可见性矩阵

---

## 6. 修复建议(只列 MED)

| ID | 建议补丁 |
|---|---|
| #1 | `toggleLike` 整体放进 `runSerializableTransaction`(刚抽出的工具),`existing` 读移入事务;或用条件写:`traceLikeStat.updateMany({where:{id, deleted: expected}})` + 仅当 `count===1` 才调 `likeCount` |
| #2 | `isLikedByMe` 单独查:`traceLikeStat.findUnique({where:{traceID_userID}, })`,或在 feed query 里对 `likeStats` 额外 include 一条 `where: { userID: viewerId }` |
| #3 | `toggleLike` 新赞分支改 `upsert`(`traceLikeStat` 已有 `@@unique([traceID,userID])`)→ 幂等,无 P2002 |
| #4 | trace `images` 复用 `assertUrlsFromStorage(dto.images, minioPublicUrl, 'trace image')`(注入 ConfigService) |
| #5 | 决定 HIDE 功能:要么实现(加 `POST /trace/:id/hide` + feed 里 `NOT { preferences: { some: { userID, type:'HIDE' } } }`),要么删模型 |

---

## 7. Phase 6 总评

- **可见性与授权是亮点**:`requireVisibleTrace` 三态正确、feed 的 `where` 把好友 PRIVATE 正确排除、`toTraceDto` 的互为好友过滤精确实现了 WeChat Moments 语义 —— 这部分逻辑干净
- **薄弱面集中在"点赞计数"**:`toggleLike` 的 find-then-transaction 不是原子的 → 并发 toggle 让 `likeCount` 漂移(MED-1);`isLikedByMe` 从截断列表算会误判(MED-2);双击撞 `@@unique` 给裸 409(MED-3)。这三个都该用刚抽出的 `runSerializableTransaction` / `upsert` 一并解决
- **功能缺口**:HIDE 偏好、PUBLIC 可见性、定位、viewCount 都是"schema 写了、代码没接"
- **无 HIGH** —— 无越权(授权严谨)、无金钱、无注入(Prisma 参数化);MED 是计数正确性 + 内容信任 + 功能完整性

下一步:Phase 7 — Upload(S3 预签名)。
