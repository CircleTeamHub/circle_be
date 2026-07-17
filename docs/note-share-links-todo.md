# 笔记分享链接 — 待办事项

> 关联 commit：`982daa8` Add note share links and readable note metadata
> ~~现状：分享链接「只写不读」~~ → 第 1、2、4 条已完成（见下）。
> 剩余：第 3 条（数量上限）、第 5 条（兜底标题）。
> 本文档记录 review 中发现的剩余工作。

---

## 1.【最关键】解析分享链接的接口（公开/访客侧）✅ 已完成

~~整个分享功能目前只做了「创建」，没做「读取」。~~

**已实现：** `GET /note/share-links/:token` —
`NoteShareLinkPublicController`（公开，无 JwtGuard）+ `NoteService.resolveShareLink`。

- [x] 按 `token` 查 `NoteShareLink`
- [x] 拒绝 `revokedAt != null`（已吊销）
- [x] 拒绝 `expiresAt != null && expiresAt < now`（已过期）
- [x] **只返回链接快照范围内的笔记**：按 `noteIDs` / `status` / `group` / `groupID` / `search` 这些存下来的筛选条件去查，**不能**直接复用 `getNote` 的 `available` 放行逻辑
- [x] 解析时重新校验笔记状态（见第 4 条）

> ~~⚠️ 注意：现在 `createShareLink` 已经会写入 `expiresAt`，但**只存不校验**。~~
> ✅ `expiresAt` 现在在解析时真正生效。**但 `revokedAt` 仍无人写入**（第 2 条），
> 即：解析侧已会拒绝被吊销的链接，只是还没有接口能把链接标记为已吊销。

补充说明（实现时的取舍）：

- 链接不存在 / 已吊销 / 已过期返回**完全一致**的 404（`NOTE_SHARE_LINK_INVALID`），
  避免访客据响应差异探测链接是否存在。
- 端点不挂 JwtGuard：凭据是 token 本身（18 字节随机数 = 144 bit，枚举不可行），
  且分享链接是二维码打开的 web 链接，扫码者没有 Circle 会话。
- 限流：`setup.ts` 的 `app.use('/api/v1/note', noteWriteLimiter)` 是 Express **前缀**
  挂载且不筛方法，本路由已被覆盖（60 次/15 分钟/IP）；另叠加 `@Throttle`
  30 次/分钟，对齐 temp-chat 的访客落地页端点。
- 无 `noteIDs` 快照的链接（纯筛选条件）本身无上界，解析上限 `SHARE_LINK_MAX_NOTES = 200`。

---

## 2. 吊销接口 ✅ 已完成

~~数据库已有 `revokedAt` 字段，但没有接口去设置它。~~

**已实现：** `DELETE /note/share-links/:id` + `GET /note/share-links` —
`NoteController`（类级 `JwtGuard`）+ `NoteService.revokeShareLink` / `listShareLinks`。

- [x] 新增 `DELETE /note/share-links/:id`（或 `POST .../revoke`），设置 `revokedAt = now`
- [x] 校验 `ownerID === 当前用户`，防止越权吊销别人的链接
- [x] 解析接口需配合校验 `revokedAt`（见第 1 条）— 已完成，解析侧已会拒绝

> ~~即：**enforcement 已就位，缺的是 writer**。~~
> ✅ writer 已补上，「吊销」端到端生效：吊销后 `/s/{token}` 立即返回 404。

补充说明（实现时的取舍）：

- 挂在 `NoteController` 而非访客侧的 `NoteShareLinkPublicController`：吊销要校验
  ownerID，必须先知道调用者是谁，而公开 controller 刻意不挂 JwtGuard。
- **幂等**：`revokedAt: null` 写在 `updateMany` 的 where 里而不是先读后判 ——
  重复吊销匹配 0 行，原始吊销时间不会被覆写，并发两次吊销同样收敛。
- 越权吊销与「链接不存在」返回**完全一致**的 404（`NOTE_SHARE_LINK_INVALID`）：
  兜底查询同样带 ownerID，不泄漏「这个 id 存在但不是你的」。
- 顺带补 `GET /note/share-links`：没有列表就拿不到 `:id`，吊销接口无从调用。
  已吊销 / 已过期的链接一并返回（`revokedAt`、`expiresAt` 都在 DTO 上，客户端自行
  展示）。**带 page/limit 分页**（默认 50、每页上限 200，对齐 `ListNotesQueryDto`）：
  只返回固定条数的话，链接数超过一屏后较老但仍然有效的链接会被较新的（哪怕已吊销
  的）挤出列表，从而看不到、也就吊销不了 —— 那会架空吊销功能本身。
  与 `listNotes` 一致返回裸数组不带 total，客户端按「返回条数 < limit」判末页。
- 限流：沿用 `setup.ts` 的 `app.use('/api/v1/note', noteWriteLimiter)`（60 次/15 分钟
  /IP，前缀挂载不筛方法，已覆盖本路由）。不额外叠 `@Throttle`：吊销是幂等更新、
  不产生新行，与同 controller 的 `deleteNote` / `deleteGroup` 保持一致。

> ⚠️ **客户端仍无入口**：`circle-im` 在 `9e8fca26` 已把分享链接 UI 整体移除
> （改为「笔记卡片发进会话」），`createNoteShareLink` 现在是无调用方的死代码，
> `revokedAt` 只出现在 `src/features/notes/types.ts` 的类型声明里。
> 本条补齐的是**后端 API 的完整性**（`revokedAt` 从此可写可查）；要真正让用户
> 管理链接，前端需先恢复创建入口，再接 `GET /note/share-links` + `DELETE`。

---

## 3. 每用户分享链接数量上限

限流（已加，10 次/分钟）只挡住了「刷接口」，但没有「单用户最多 N 个有效链接」的硬上限，长期仍会无限增长。

- [ ] 创建前统计该用户未吊销/未过期的链接数，超过上限（如 100）报错
- [ ] 或提供清理过期链接的后台任务

---

## 4. 解析时重新校验笔记状态 ✅ 已完成

创建链接时校验了笔记归属 + 未删除，但链接创建后，笔记可能被删除或取消 `available`。

- [x] 解析接口返回笔记前再查一次当前状态，过滤掉已删除 / 已下架的笔记
- [x] 不要信任 `noteIDs` 快照里的内容仍然有效

实现于 `NoteService.buildShareLinkNoteFilter`：`available: true` 与
`status`（快照值或 `{ not: 'DELETED' }`）是**过滤条件**，每次解析实时求值，
`noteIDs` 只用于收窄范围、不作为「可见」依据。

---

## 5.（小）服务里硬编码的中文兜底标题

`note.service.ts` 的 `createShareLink` 里有 `dto.title.trim().slice(0, 120) || '我的笔记'`，
空白标题（`@IsNotEmpty` 允许 `"   "`）会触发兜底。属于轻微 i18n 问题，优先级低，可暂不动。

---

## 已完成（本次 review 一并修复，供参考）

- ✅ 分享链接创建接口加限流（`@UseGuards(ThrottlerGuard)` + `@Throttle` 10 次/分钟）
- ✅ DTO 支持可选 `expiresInDays`（1–365），创建时写入 `expiresAt`
- ✅ 修正 `getNote` 的 Swagger 描述（已从「My note detail」改为说明可读 available 笔记）
- ✅ 补充单测：过期时间持久化 / `group`+`groupId` 互斥 / token 冲突重试

---

## 实现顺序建议

~~1 → 2 → 4 一起做~~ → 1 和 4 已完成（`feat: resolve note share links with expiry and revocation checks`）。
~~2 未做~~ → 2 已完成（`feat: revoke and list note share links`，叠在上面那个 PR 之上）。
3、5 可后续单独处理。
