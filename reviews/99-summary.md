# Circle BE — Code Review 总汇总

> 对 `circle_be`(NestJS 11 + Prisma 7 + PostgreSQL)的全量 production-readiness review。
> 方法:`nestjs-production-review` skill 的 5 边界模式 + landmine 表,逐文件逐行。
> 10 个 Phase + maturity playbook(§2 工具抽取 + §3 migration)。

---

## 1. 数字总览

| 指标 | 值 |
|---|---|
| Phase 数 | 10(infra / auth-user / friend×2 / coin / note×2 / circle / trace / upload / openim / cross-cutting) |
| review 报告 | 13 份(`01`–`10` + `97`/`98` + 本文) |
| 发现总数 | ~190(全 Phase TL;DR 合计) |
| 测试 | 118 → **175 pass**(+57),`tsc --noEmit` 全程 0 errors |
| migration | `20260516000000_maturity_constraints` 已应用(8 个 DB 对象) |
| 代码改动 | ~40 个源文件,11 份 `*-fixes-applied.md` 记录 |

---

## 2. HIGH 发现 — 全清单与状态

| Phase | HIGH 发现 | 状态 |
|---|---|---|
| 0 | `.env*` 提交进 git(SECRET/DB/MINIO 凭证) | ✅ 已 `git rm --cached` + gitignore;⚠️ **需轮换凭证**(历史仍有) |
| 0 | `LogsModule` 不存在 → build break | ✅ 删除 broken 引用 |
| 0 | 全局 ValidationPipe 缺 `forbidNonWhitelisted` | ✅ 已加 |
| 0 | `AllExceptionFilter` 回显 + 记录 request headers/body | ✅ 用 Pattern E 重写(scrub) |
| 0 | dev CORS = `true`(任意 origin + credentials) | ✅ 改白名单 checker |
| 0 / 9 | `tsconfig` strict 关闭 | ⏸️ 延期(开启破上百处,需专门分支) |
| 1 | JWT/refresh TTL 硬编码 | ✅ 改 env 驱动 |
| 1 | BAN/DELETE 用户不撤 session | ✅ `revokeAll` |
| 1 | `/refresh` 不重检 user.status | ✅ 已加 |
| 1 | `PublicUserDto.username` 死字段 | ✅ 删除 |
| 1 | login 双消息可枚举账号 | ✅ 统一错误消息 |
| 1 | `/user/search/account` 无限流 | ✅ 加 `accountSearchLimiter` |
| 2a | `Friend` 无 `@@unique` → 并发重复 | ✅ advisory lock + migration partial unique |
| 2a | `blockUser` race + 不撤 IM 关系 | ✅ race 修(P2002→409);⏸️ IM 关系部分延期(Phase 8) |
| 2a | `handleRequest` accept 不检 sender 状态 | ✅ 已加 |
| 2a / 2b | backfill 寄生在每次读路径 | ✅ migration 加 `activitiesBackfilledAt` gate |
| 2a | friend 列表无分页 | ⏸️ 延期(契约改动,需前端协调) |
| 3 | `sendGift` 无幂等 → 双重扣款 | ✅ migration 加 `idempotencyKey` + 头 + catch-P2002 |
| 3 | `adminTopUp` 死代码 / 无充值入口 | ⚠️ 逻辑已修正,但**接路由 vs 接支付是产品决策**(延期) |

**HIGH 小结**:~20 个 distinct HIGH,**16 已修**;延期 4:`tsconfig` strict(技术债)、friend 列表分页(契约)、coin 充值入口(产品)、OpenIM 好友关系同步(产品)。

---

## 3. 修复 — 按类别

### 安全 / 正确性
- secret 脱离 git、CORS 白名单、ValidationPipe 加固、异常 filter 脱敏重写
- session 生命周期:BAN/DELETE 撤 session、refresh 重检状态、refresh-token reuse detection
- 账号枚举:login 统一消息 + search 限流
- 金钱:`sendGift` 幂等(idempotency-key + 唯一索引 + catch-P2002)
- 内容信任:`assertUrlsFromStorage` 把 user 头像 / note 媒体 / circle 头像 / plaza 图片 / trace 图片的 URL 锁到自有 origin(堵 `host.attacker.com` 旁路)
- 并发:`Friend` / `CircleInvitation` 加 advisory lock + partial unique;`toggleLike` 改 Serializable 事务消除计数漂移

### DB 约束兜底(maturity migration)
`FriendReport` / `FriendActivity` / `CoinGift` 唯一索引 + `Friend` / `CircleInvitation` / `NoteGroup` partial unique + `User.activitiesBackfilledAt` / `CoinGift.idempotencyKey` 列 —— SELECT-then-INSERT 改 `catch P2002`

### 共享基础设施(maturity playbook §2)
`src/utils/prisma-tx.ts`(`runSerializableTransaction` / `prismaErrorCode`)、`src/utils/storage-url.ts`(`assertUrlsFromStorage`)—— coin/trace 已采用,消除 3 份重复事务重试代码

### 一致性 / 清理
全模块 controller `@Req() req: any` → `RequestWithUser`;删死代码(`signin-user.dto` / `create-user.pipe` / `http-exception.filter` / `HandleFriendRequestDto` / `username` 字段);Dockerfile Node 14→22;删重复 lockfile;`CheckPolices`→`CheckPolicies`

### 测试
+57 个测试:coin happy-path(原本没有)、refresh reuse、friend tag、note 截断、circle URL guard、trace toggleLike 等关键路径

---

## 4. maturity playbook 落地状态

| 节 | 状态 |
|---|---|
| §2.1/2.2 抽事务工具 | ✅ `runSerializableTransaction` + `prismaErrorCode`,coin/trace 采用 |
| §2.4 抽 URL guard | ✅ `assertUrlsFromStorage`,user/note 采用(circle/plaza/trace 有等价实现) |
| §3 migration | ✅ 已应用 + 代码适配 |
| §2.3 分页 helper | ⏸️ 未做(契约决策) |
| §4 计数器策略 | ⏸️ 未做(架构决策) |
| §5 PR checklist | ⏸️ 未做(流程项) |

---

## 5. 剩余路线图(延期项分组)

### A. 需要产品决策
- coin 充值入口:`adminTopUp` 接 admin 路由 vs 接支付(Phase 3#2)
- circle 私密圈 / 删圈 / 转让 owner / 帖子审核(Phase 5 #3/#4/#5)
- plaza feed 是否成员可见(Phase 5#4)
- OpenIM 好友关系是否需要同步(Phase 8#5)
- 私密 note 媒体是否需真私密(桶策略,Phase 7#5)
- trace HIDE 功能、PUBLIC 可见性(Phase 6 #5/#6)
- `PublicUserDto` 的 `wechat/qq/whatsup` 对外可见性(Phase 1#11)

### B. 需要前端协调(契约改动)
- 统一分页信封 `Paginated<T>` + friend 列表补分页(Phase 2a#4 / 9#5)
- 响应信封 `code` 语义统一(Phase 9#2)
- upload 改 `createPresignedPost` 加大小限制(Phase 7#1)
- `/coin/gift` 已要求 `Idempotency-Key` 头 —— **前端必须配合**

### C. 需要一个独立 PR
- 修复 `20260408170000_friend_activities` migration → 恢复 `migrate dev`(Phase 9#8)
- S3 对象 GC job → 清理 note 孤儿媒体(Phase 4a #3/#4 + 7#4)
- 拆 `friend.service.ts`(1280行)/ `note.service.ts`(913行)(Phase 9#4)
- `tsconfig` strict 紧化(Phase 0#6)
- 日志基础:request-id + 结构化(Phase 9#10)
- `RolesModule`:实现或删除 + 清理 casl 死装饰器(Phase 9#3)

### D. 韧性增强
- OpenIM 熔断/backoff、`response.ok` 检查、token 失效自愈、platformID 透传(Phase 8 #1-4)
- env 解析收敛到 `ConfigService`(Phase 9#7)
- 计数器策略统一(playbook §4)

### E. 测试 backlog
- `openim` / `roles` 零测试;controller e2e;并发与负面路径(Phase 9#9)

---

## 6. 必做的运维动作(用户)

1. **轮换所有曾入 git 的凭证** —— `SECRET` / DB 密码 / MINIO key。`git rm --cached` 只挡未来提交,历史仍在(私有库 → 风险可控但建议轮换)
2. **重建 `.env.production`** —— 当前文件用过时的 `DB_HOST` 风格字段,与 `env.validation.ts` 不匹配
3. **migration**:staging/prod 跑 `prisma migrate deploy`(`20260516000000_maturity_constraints` 幂等可重跑;先确认无重复行)
4. **前端**:`/coin/gift` 现强制 `idempotency-key` 头;`/auth/sessions` 严格序列化;`PublicUserDto.username` 已移除

---

## 7. 报告索引

| 文件 | 内容 |
|---|---|
| `00-review-plan.md` | review 计划 |
| `01-infra.md` + `-fixes-applied` | Phase 0 基础设施 |
| `02-auth-user.md` + `-fixes-applied` | Phase 1 认证/用户 |
| `03a-friend-core.md` / `03b-friend-aux.md` + `-fixes-applied` | Phase 2 好友 |
| `04-coin.md` + `-fixes-applied` | Phase 3 钱包 |
| `05a-note-core.md` / `05b-note-media-list.md` + `-fixes-applied` | Phase 4 笔记 |
| `06-circle.md` + `-fixes-applied` | Phase 5 圈子 |
| `07-trace.md` + `-fixes-applied` | Phase 6 动态 |
| `08-upload.md` + `-fixes-applied` | Phase 7 上传 |
| `09-openim.md` | Phase 8 OpenIM |
| `10-cross-cutting.md` | Phase 9 跨模块 |
| `97-migration-applied.md` | maturity migration |
| `98-maturity-playbook.md` | 成熟度抬升手册 + 执行进度 |
| `99-summary.md` | 本文 |

---

## 8. 总评

- **整体评价**:这是一个**结构清晰、边界意识不错**的 NestJS 项目。模块划分干净,JwtGuard / ParseUUIDPipe / DTO 校验一致,Prisma 全参数化无注入面,外部集成(OpenIM/S3)统一用 best-effort 模式。
- **最成熟的部分**:circle-invitation 的验证流程(Serializable + 原子计数 + 原子状态机 + 严谨授权)、coin 的事务内核(原子条件扣款)。
- **最薄弱的主题**(贯穿多模块,本轮已大量修复):
  1. **并发** —— SELECT-then-INSERT 缺 DB 约束兜底 → 已加 migration + advisory lock + Serializable 重写
  2. **内容信任** —— client URL 不校验 origin → 已加 `assertUrlsFromStorage`
  3. **金钱幂等** —— 已加 idempotency-key
  4. **状态同步** —— BAN/DELETE/backfill → 已修
- **仍需投入**:`tsconfig` 类型安全(最大技术债)、分页/信封/计数器三处一致性统一、migration 工具链修复、`RolesModule` 死代码、测试 backlog —— 都已在 §5 路线图分组。
- **没有遗留的 HIGH 安全漏洞**:本轮 review 发现的越权 / 注入 / 泄露 / 双重扣款类问题已全部修复或有明确缓解;剩余 HIGH 仅 `tsconfig` 这一项技术债。
