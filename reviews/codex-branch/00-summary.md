# codex/dev-test-logging — Pre-merge Production Review

> 对 `codex/dev-test-logging`(11 commits / 118 文件 / +7495 行)在合并进 `main` 前的 production-readiness review。
> 方法:`nestjs-production-review` skill 的 5 边界模式 + landmine 表。5 个并行 review agent,分域逐文件。

---

## 1. 范围

codex 分支从旧 main(`d57be7a`)分叉,**没有**当前 main 的 4 个 review-remediation commit。新增模块:
`realtime`(WebSocket)、`notification`、`membership`、`mall`、`collection`、`icon`、`conversation-group`、`logging`(12 文件)、`logs`(stub)。
另改动 auth/circle/friend/trace/user/coin/note/openim/upload/schema。

---

## 2. HIGH 发现 — 合并阻塞项

| # | 位置 | 描述 | 类型 |
|---|---|---|---|
| H1 | `coin.controller.ts:48-53` + `coin.service.ts:50-80` | **`POST /coin/recharge` 免费自充值** —— 任意登录用户给自己钱包加任意点数,无支付、无校验、无 admin 守卫。等于把 `adminTopUp` 开放给所有人。点数能买 VIP / 送礼 → 经济系统崩塌 | 代码 |
| H2 | `coin/dto/coin.dto.ts:28-33` | `RechargeDto.amount` 只有 `@Min(1)`,**无 `@Max`**、service 层无上限 → 单次可造数十亿点数 | 代码 |
| H3 | `realtime.gateway.ts:78-87` | **WS URL-token 认证仍生效** —— `?token=<JWT>` 从握手 URL 取 token,JWT 会落进 nginx/ALB 访问日志、代理缓存、Referer。代码自己 warn 了"deprecated"却仍接受 | 代码 |
| H4 | `realtime.gateway.ts:202-214` | **WS token 不区分类型** —— 用共享 SECRET verify,只查 `sub` 是 string。long-lived refresh token 也能换 realtime 会话,绕过 15 分钟 access TTL | 代码 |
| H5 | `conversation-group.service.ts:113-150` | **`setMembers` IDOR** —— 只校验 caller 拥有 group,不校验 caller 是每个 `conversationID` 的参与者。可把任意会话(含别人的)绑进自己 group → 跨用户聊天泄漏。`note.updateNoteGroupIds` 已有正确范式(`requireOwnedGroups`)可参照 | 代码 |
| H6 | `.env` / `.env.development` / `.env.production` / `.env.test` | codex 分支**仍 track 这些文件**,内含真实 JWT `SECRET` 与 `postgres:postgres` 凭证 | git 卫生 |
| H7 | `.gitignore` | codex 分支**无 `.env*` 忽略规则** | git 卫生 |

**H6/H7 说明**:当前 main 已在 commit `809fa87` 把 `.env*` 从 git 移除并加了 `.gitignore` 规则。合并时:
- `.env*` 文件 → modify/delete 冲突,**解为删除**即可。
- `.gitignore` → main 的 `.env` 规则会保留(codex 只改了 `logs/`→`/logs/` 不同 hunk)。
- 所以 H6/H7 在合并解冲突时自动消除;但 SECRET 已进 codex 分支历史 → **仍需轮换**(与之前 review 的轮换建议同一项)。

**真正的代码阻塞项 = H1–H5**(5 个)。

---

## 3. MEDIUM 发现

| 域 | 发现 |
|---|---|
| realtime | WS server 无 `maxPayload`(无界 auth 帧);未认证 socket 无 per-IP 上限(每个占 10s → FD 耗尽);`createTraceCommentNotifications` 2 次 `notification.create` 无 `$transaction` 包裹 → 部分失败留孤儿 |
| coin | `recharge` / `membership/upgrade` 无 per-route 限流、无 idempotency-key → 重试双重入账(仅 `/coin/gift` 在 setup.ts 限流) |
| 全局 | 全局 `ValidationPipe` 缺 `forbidNonWhitelisted`(codex 分支从旧 main 分叉,未含 main 的加固;**合并后会被 main 版本覆盖,自动修复**) |
| conversation-group | ownership 校验在 `$transaction` 外 → 并发 `remove` 抛裸 500(P2025)而非 404;`conversationIDs` 无 `@ArrayMaxSize` / 逐项 `@MaxLength`;写端点无 `@Throttle` |
| note | `updateNoteGroupIds` 的 `createMany` 缺 `skipDuplicates`(实际靠前置 `deleteMany` 兜底,脆弱) |
| logging | `POST /logs` stub 原样回显 request body 并 `console.log`(log injection + 死代码);`request-logger.middleware` 每请求在 `res.on('finish')` 同步写文件 transport,`httpLogOn` 生产默认开 |
| icon/user | circle 换图标后 30s 缓存陈旧(自愈);`updateBasicProfile` 跳过 `update` 走的 `assertUrlsAreSafe` 守卫 —— 需确认 |

---

## 4. Verified OK(做对的)

- **membership / mall / collection / icon 四个新模块本身干净**:原子 debit+grant 事务、`updateMany` 条件扣款防负数/双花、price/userId 服务端派生、collection 删除无 IDOR、嵌套 DTO 校验强。单独看可合并。
- realtime emit 端授权可靠:`broadcast` 严格限定目标用户自己的 socket,无 subscribe/join handler → 结构上不可能跨用户泄漏;`safeBroadcastAll` 隔离 WS 故障。
- conversation-group migration SQL 与 `schema.prisma` 完全一致;4 个 migration 全部 additive 无破坏性;无 schema/migration drift。
- OpenIM diff:5s `AbortSignal.timeout`、UUID 去连字符一致、失败日志不带 token/body。
- logging 各 logger 不记 body/header/token;查询串从 path 剥离;`LogsController` 有 `JwtGuard+AdminGuard+CaslGuard`。无 DB-backed logs 表(out of scope)。
- 无 destructive migration;授权(circle `assertOwner`、trace 可见性)完好。

---

## 5. 合并机制

- codex 与 main 的 merge-base = `d57be7a`(旧 main)。
- **38 个文件被双方同时改动** → 真正的三方合并,必有冲突。
- 冲突大头:`setup.ts`、`main.ts`、`app.module.ts`、`schema.prisma`、`coin.service.ts`、`user.service.ts`、`note.service.ts`、`trace.service.ts`、`upload.service.ts`、`circle*.ts`、`friend.service.ts`、`env.validation.ts`、`.env*`、`package.json`、各 spec。

---

## 6. 结论

**NOT merge-ready as-is.** 5 个代码 HIGH(H1–H5)是真实 ship-blocker,其中 H1(免费造钱)灾难级。
建议:先在 codex 分支修掉 H1–H5(+ MEDIUM 中的限流/idempotency/事务),再做合并解冲突;或在合并解冲突的同时一并修。
H6/H7 + SECRET 轮换随合并自然处理。
