# 笔记分享链接 — 待办事项

> 关联 commit：`982daa8` Add note share links and readable note metadata
> ~~现状：分享链接「只写不读」~~ → 第 1、4 条已完成（见下）。
> 剩余：第 2 条（吊销接口）、第 3 条（数量上限）、第 5 条（兜底标题）。
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

## 2. 吊销接口 ← 目前「吊销」不可用的唯一缺口

数据库已有 `revokedAt` 字段，但没有接口去设置它，链接目前无法主动作废。
客户端也没有吊销入口（`circle-im` 里 `revokedAt` 只出现在类型定义中）。

- [ ] 新增 `DELETE /note/share-links/:id`（或 `POST .../revoke`），设置 `revokedAt = now`
- [ ] 校验 `ownerID === 当前用户`，防止越权吊销别人的链接
- [x] 解析接口需配合校验 `revokedAt`（见第 1 条）— 已完成，解析侧已会拒绝

> 即：**enforcement 已就位，缺的是 writer**。补上本条后「吊销」即可端到端生效，
> 解析侧无需再改。

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
2 未做：它是**写**路径（需要 owner 校验），与解析解耦，单独一个 PR 更好审。
3、5 可后续单独处理。
