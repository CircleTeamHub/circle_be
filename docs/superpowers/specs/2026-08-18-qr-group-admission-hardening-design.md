# QR 与独立群聊准入加固设计

日期：2026-08-18

## 背景与目标

本设计修复配对 PR CircleTeamHub/Circle_frontend#171 与 CircleTeamHub/circle_be#161 的五个 production review finding：

1. 前端二维码解析面对非法 percent encoding 时会抛出 `URIError`。
2. 独立群聊 200 人上限没有覆盖建群和好友邀请。
3. QR 入群使用“计数后写入”，并发时可能突破 200 人上限。
4. 永久有效的个人名片二维码没有用户可用的撤销/轮换入口。
5. 二维码签发使用 `findFirst → create`，并发时可能生成多个有效 token。

目标是在不改变群聊/圈子二维码七天有效及旧码自然过期语义的前提下，关闭上述崩溃、容量和凭证生命周期风险。

## 范围

- 前端：安全解析二维码载荷；仅个人名片二维码页面增加“重置二维码”入口。
- 后端：统一独立群聊容量检查与并发串行化；串行化 token 签发；增加个人名片 token 轮换 API。
- 数据库：复用 PostgreSQL 事务锁，不新增表，不修改现有二维码有效期。
- 不在范围内：群聊或圈子二维码的手动重置 UI；全群级别一次性撤销所有成员签发的群二维码；更改 200 人上限。

## 设计

### 1. 安全二维码解码

`src/features/qr/qr-payload.ts` 增加私有安全解码函数。它调用 `decodeURIComponent`，捕获 `URIError` 后返回 `null`。query 与 path 两个解析分支都通过该函数处理。

非法编码、解码后不符合 token 字符集、非本站 URL 都返回 `null`；解析函数不向消息 mapper 或渲染层抛出异常。

### 2. 独立群聊容量与并发控制

总人数上限仍为 200，包含群主。

- 建群：去重并剔除群主后，邀请成员最多 199 人；超限直接返回现有 `ChatErrorCode.GroupFull`，不访问好友或用户表。
- 好友邀请：好友授权检查可在事务外完成；真正的成员状态读取、容量检查与 create/reactivate 在事务内完成。
- QR 入群：既有成员查询移动到事务内，避免锁外状态失效。

邀请和 QR 入群在事务内先执行：

```sql
SELECT "id", "type", "circleID"
FROM "ChatConversation"
WHERE "id" = $1
FOR UPDATE
```

持有会话行锁后重新确认它仍是独立 GROUP，读取本次候选成员的座位状态并统计 `leftAt IS NULL` 的在座人数。只有当“当前在座人数 + 本次实际新增/复位人数 <= 200”时才写入。所有修改同一会话成员资格的这两个入口共用该锁，因此并发请求按会话串行。

已在座用户保持幂等，不占新增容量；离群后重新加入按一个新增座位计算，并继续抬高 `clearedBeforeHeight`，不回放离群前历史。

### 3. Token 签发串行化

`QrService.issueToken` 在通过现有签发资格检查后进入事务，并获取按以下稳定字符串派生的 PostgreSQL transaction advisory lock：

```
qr-token:<issuerID>:<type>:<targetID>
```

锁内重新查询可复用 token；不存在时才创建。相同签发者、类型和目标的并发请求被串行化，后到请求会复用先到请求创建的 token。不同签发键互不影响；理论 hash 冲突只会让低频签发短暂互等，不影响正确性。

该方案不增加“只能存在一个未撤销 token”的数据库约束，因为 GROUP/CIRCLE 当前允许旧 token 在自身七天窗口内继续有效。自动轮换语义保持不变。

### 4. 个人名片二维码重置

新增：

```
POST /qr/tokens/rotate
Body: { "type": "USER" }
Response: QrTokenDto
```

当前版本只允许 `type=USER`，且目标固定为当前登录用户。服务端在与普通签发相同的 advisory lock 内：

1. 将该用户所有 `type=USER`、`targetID=userId`、`issuerID=userId`、`revokedAt IS NULL` 的 token 更新为同一个 `revokedAt` 时间。
2. 创建一个新的永久 USER token。
3. 返回新 token。

事务保证撤销和创建一起成功或一起回滚。旧 token 随后在 resolve、好友请求校验等所有依赖 `requireValidToken` 的路径上返回无效。

前端 `QrCodeScreen` 仅在个人名片页面显示“重置二维码”。点击后先显示确认框；确认后禁用保存、分享和重置操作，调用 rotate API，成功时原地替换 token/二维码并提示成功，失败时保留旧二维码显示并给出可重试错误。群聊和圈子页面不显示该入口。

### 5. 错误处理与兼容性

- 复用 `ChatErrorCode.GroupFull` 表示所有建群、邀请和 QR 入群超限。
- rotate 请求不接受 GROUP/CIRCLE，返回现有二维码签发拒绝错误语义。
- API 增量兼容旧客户端；旧客户端仍可正常签发和使用个人二维码，只是没有重置入口。
- 被撤销 token 继续使用既有 `QrErrorCode.Invalid`，不暴露 token 是否曾经存在。
- 前端非法二维码卡片静默不渲染，不向用户展示内部解析错误。

## 测试策略

### 前端

- `qr-payload.test.mts`：非法 query 编码和非法 path 编码均返回 `null`，且不抛异常。
- mapper/hostile-card 测试：恶意 `qr-card` payload 被净化为空，不中断消息历史映射。
- QR 页面/API 接线测试：个人页面展示重置入口；群聊/圈子不展示；确认后调用 rotate；成功替换 token；失败保留当前 token 并恢复按钮状态。
- i18n 五种语言包含确认、成功、失败和按钮文案。

### 后端

- 建群：200 人总量成功，201 人被 `GroupFull` 拒绝。
- 邀请：按实际新增/复位人数计算容量；已在座成员不重复计数；超限事务不写入。
- QR 入群：199 人时两个并发请求最多一个成功；已在座请求保持幂等。
- Token 签发：同一签发键的并发请求只创建一次并返回同一 token。
- Token 轮换：只撤销当前用户的 USER token；新 token 可解析；旧 token 返回 Invalid；事务失败时旧 token 保持有效且不返回新 token。
- Controller/DTO：rotate 需要认证，只接受 USER。

## 验证门禁

前端必须通过：

```
npm run typecheck
npm run lint
npm test
npm run test:behavior
npm run ci
```

后端必须通过仓库既有 lint、test、build、migration/E2E、dependency audit 与 Docker/Trivy CI。两个 PR 的跨仓 contract test 必须继续使用配对分支并通过。
