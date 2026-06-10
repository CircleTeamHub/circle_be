# 笔记分享链接 — 待办事项

> 关联 commit：`982daa8` Add note share links and readable note metadata
> 现状：分享链接「只写不读」——已能创建，但还没有任何接口去消费 `/s/{token}`。
> 本文档记录 review 中发现、本次未实现的剩余工作。

---

## 1.【最关键】解析分享链接的接口（公开/访客侧）

整个分享功能目前只做了「创建」，没做「读取」。访客打开 `/s/{token}` 后，后端没有接口换取笔记数据。

**要做：** 新增解析接口（如 `GET /note/share-links/:token` 或访客侧路由），逻辑必须包含：

- [ ] 按 `token` 查 `NoteShareLink`
- [ ] 拒绝 `revokedAt != null`（已吊销）
- [ ] 拒绝 `expiresAt != null && expiresAt < now`（已过期）
- [ ] **只返回链接快照范围内的笔记**：按 `noteIDs` / `status` / `group` / `groupID` / `search` 这些存下来的筛选条件去查，**不能**直接复用 `getNote` 的 `available` 放行逻辑
- [ ] 解析时重新校验笔记状态（见第 4 条）

> ⚠️ 注意：现在 `createShareLink` 已经会写入 `expiresAt`，但**只存不校验**。在解析接口落地前，「过期时间」不能真正限制访问。

---

## 2. 吊销接口

数据库已有 `revokedAt` 字段，但没有接口去设置它，链接目前无法主动作废。

- [ ] 新增 `DELETE /note/share-links/:id`（或 `POST .../revoke`），设置 `revokedAt = now`
- [ ] 校验 `ownerID === 当前用户`，防止越权吊销别人的链接
- [ ] 解析接口需配合校验 `revokedAt`（见第 1 条）

---

## 3. 每用户分享链接数量上限

限流（已加，10 次/分钟）只挡住了「刷接口」，但没有「单用户最多 N 个有效链接」的硬上限，长期仍会无限增长。

- [ ] 创建前统计该用户未吊销/未过期的链接数，超过上限（如 100）报错
- [ ] 或提供清理过期链接的后台任务

---

## 4. 解析时重新校验笔记状态

创建链接时校验了笔记归属 + 未删除，但链接创建后，笔记可能被删除或取消 `available`。

- [ ] 解析接口返回笔记前再查一次当前状态，过滤掉已删除 / 已下架的笔记
- [ ] 不要信任 `noteIDs` 快照里的内容仍然有效

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

1 → 2 → 4 一起做（解析 + 吊销 + 状态校验是一套完整的「读」闭环，需配独立测试）
3、5 可后续单独处理。
