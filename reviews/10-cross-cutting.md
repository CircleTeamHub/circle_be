# Phase 9 — Cross-cutting Review

> 范围:跨模块的一致性、可维护性、运维与工程化问题 —— 不属于任何单一模块,而是整个 codebase 的横切关注点。综合前 8 个 Phase 的 deferred 跨切项 + 本轮新采集的数据。
> 数据采集:`grep` / `wc` / migration 状态(已执行)。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 范围 | 描述 |
|---|---|---|---|
| 1 | **HIGH(技术债)** | `tsconfig.json` | `strictNullChecks` / `noImplicitAny` / `strictBindCallApply` 全关 —— 全项目类型安全降级。Phase 0 #6 已记;开启会触发上百处错误,需专门紧化分支 |
| 2 | **MED** | 响应信封 | `ResponseInterceptor` 成功 = `{ code: 0, message: 'ok', data }`;两个异常 filter = `{ code: <HTTP status>, message, data }`。`code` 在成功/失败下语义不同(`0` vs `404`)→ 客户端要解两套 |
| 3 | **MED** | `RolesModule` | `RolesService` 5 个方法**全是 stub**(`return null` / `[]`);`RolesController` 把 5 个死 CRUD 端点挂在 `/roles` 上。admin-guarded 无安全风险,但是**非功能 API 表面 + 死代码**;且 controller 无 `@ApiTags`/`@ApiBearerAuth`,`findOne(+id)` 用数字 id 与全项目 UUID 不一致 |
| 4 | **MED** | 巨型 service | `friend.service.ts` **1280 行**、`note.service.ts` 913、`circle-invitation.service.ts` 639 —— 远超 coding-style 的"800 max"。friend/note 应拆(friend → 请求生命周期/标签/活动;note → note/group/媒体派生) |
| 5 | **MED** | 分页 | 三种不一致:circle/plaza/trace 返回 `{items,total,page,limit,hasMore}`;note `listNotes` 返回裸数组(内部有 take/skip);friend 列表**完全无分页**;coin `getTransactions` 硬顶 50。无统一分页契约(playbook §2.3) |
| 6 | **MED** | 计数器 | 反范式计数器(`memberCount`/`postCount`/`likeCount`/`replyCount`/`mediaCount`)有的事务保护、有的会漂移(circle memberCount)、有的从不写(`Trace.viewCount`、`CirclePost.viewCount` 两个死字段)。无统一策略(playbook §4) |
| 7 | **MED** | env 解析 | `getServerConfig` 被 `main.ts` / `server.config.ts` / `prisma.service.ts` 三处独立调用,与 `ConfigModule` 的解析路径并行 —— 同一份 env 多解析源,漂移风险(Phase 0 #11) |
| 8 | **MED** | migration 工具链 | `20260408170000_friend_activities` 在 shadow DB 隔离回放报 `FriendState 不存在` → `prisma migrate dev` 不可用,团队被迫 `migrate deploy` + 手写 migration。migration 历史本身有缺陷,需修复 |
| 9 | **MED** | 测试覆盖 | 28 个 spec 文件;`openim` / `roles` **零测试**;多数模块 controller 路径、负面 case、并发 case 覆盖薄(各 Phase 报告已逐一列) |
| 10 | **MED** | 日志 | 无 request-id 关联、无结构化日志。`codex/dev-test-logging` 分支有完整 winston+request-id 基础(~800 LOC)但从未合并;现用 Nest 默认 ConsoleLogger |
| 11 | LOW | 运维 | dev DB 已偏离 committed schema(带 `IconAsset` 等并行分支对象)—— 共享多分支库,应每分支独立库或收敛分支(详见 `97-migration-applied.md`) |
| 12 | LOW | `setup.ts` | 5 处 Express 中间件 `(req: any, res: any, next: any)` —— 应用 `express` 的 `RequestHandler` 类型 |
| 13 | LOW | i18n | 错误消息中英混用(多数英文,circle-plaza/friend 部分中文);无 i18n 层 |
| 14 | LOW | `tx: any` | friend/circle/note 的事务回调把 `tx` 当 `any`;新抽的 `runSerializableTransaction` 用 `Prisma.TransactionClient` —— 不一致 |
| 15 | LOW | `@Global()` | `AuthModule` / `UserModule` / `PrismaModule` 都 `@Global()` —— 依赖图隐式化,调试时不易看清谁依赖谁 |

共 **15 项**:HIGH 1、MED 9、LOW 5。

---

## 1. 类型安全(#1)

`tsconfig.json`:`strictNullChecks:false`、`noImplicitAny:false`、`strictBindCallApply:false`、`forceConsistentCasingInFileNames:false`、`ignoreDeprecations:"6.0"`。

- 后果:`null`/`undefined` 不被编译器追踪;隐式 `any` 蔓延(各 service 的 `tx: any`、`trace: any`、`circle: any` 都是症状)
- 这是**全项目最大的单项技术债**,但开启是破坏性的(连带上百处报错)
- 建议:专门分支,先开 `strictNullChecks`(收益最大),逐文件修;`noImplicitAny` 其次

## 2. API 契约一致性

### 响应信封(#2)
- 成功:`{ code: 0, message: 'ok', data }`
- 失败:`{ code: 404, message, data: null }`
- `code` 双语义。建议:统一 —— 要么成功也用 HTTP 200 而 `code` 恒为 HTTP 状态,要么定义一套独立业务码并文档化

### 分页(#5)
- 三种形态并存。建议:定义 `Paginated<T> = { items: T[]; total: number; page: number; limit: number; hasMore: boolean }`,所有列表统一;friend 列表补分页(2a#4)

### Roles 死模块(#3)
- `RolesService` 全 stub。`/roles` 的 5 个端点对外可见但无行为。建议:实现或删除;`roles.decorator` / `casl.decorator` 同属"基础设施搭好、无人使用"(casl 三装饰器零 call site,见 Phase 1 LOW-20 区域)

## 3. 可维护性

### 巨型 service(#4)
| 文件 | 行数 | 建议 |
|---|---|---|
| `friend.service.ts` | 1280 | 拆 `friend-request.service` / `friend-tag.service` / `friend-activity.service` |
| `note.service.ts` | 913 | 拆 `note.service` / `note-group.service`;媒体/内容派生抽 helper 文件 |
| `circle-invitation.service.ts` | 639 | 临界,可暂留 |

### env 解析(#7)
`getServerConfig` 与 `ConfigModule` 并行存在。建议:统一走 `ConfigService`,删 `server.config.ts`,`PrismaService` 改注入 `ConfigService`(注意 `PrismaService` 在 `ConfigModule` 之前初始化的顺序问题 —— 需要 `forRootAsync` 或显式 import 顺序)

## 4. 工程化

### migration 工具链(#8)
`prisma migrate dev` 因 shadow DB 回放失败而不可用。**根因**:`20260408170000_friend_activities` 在隔离回放时引用了尚未创建的 `FriendState` 枚举。建议:修复该 migration(把 enum 创建挪到引用之前),恢复 `migrate dev`;否则团队只能手写 migration(本次 maturity migration 已是这么做的)

### 测试覆盖(#9)
- `openim` / `roles` 零 spec
- 各 Phase 报告已逐模块列出缺口(coin happy-path 此前缺、friend 测试覆盖死代码、note 列表过滤未测 等 —— 大部分已在对应 fixes 补)
- 建议:补 `openim`(token 缓存 / `enabled` 门控可测)、controller e2e、并发与负面路径

### 日志(#10)
现用 Nest 默认 logger。Phase 0 重写的 `AllExceptionFilter` 已做请求级 scrub + 结构化错误日志,但**无 request-id 贯穿**。建议:合并 `codex/dev-test-logging` 的 winston+request-id 基础,或自建一个 request-id 中间件 + `ResponseInterceptor` 里带上

---

## 5. Verified OK(跨模块做对的)

- **模块结构一致**:每模块 `module / controller / service / dto`,清晰
- **`JwtGuard` 一致覆盖**:所有业务 controller 类级 `@UseGuards(JwtGuard)`
- **`ParseUUIDPipe` 一致**:所有 UUID 路径参数都校验
- **`RequestWithUser` 已铺开**:auth/user/friend/coin/note/circle×3/trace/upload 的 controller `@Req()` 都已强类型(本轮逐 Phase 修完)
- **5 个边界模式基本到位**:strict DTO + 全局 ValidationPipe(已加 `forbidNonWhitelisted`)、server-derived identity、事务包裹、限流、scrubbed 异常 filter
- **共享工具已抽出**:`runSerializableTransaction` / `prismaErrorCode` / `assertUrlsFromStorage`(playbook §2)
- **DB 约束兜底已落地**:maturity migration 的 8 个对象(playbook §3)
- **外部集成统一 best-effort**:OpenIM / S3 调用都"事务外 + 非阻塞 + catch",故障不污染业务数据
- **Prisma 参数化**:全项目无字符串拼 SQL,无注入面(唯一 raw SQL 在 `deleteGroup` 的重排,已参数化)

---

## 6. 修复优先级(跨模块)

| 顺序 | 动作 | 类型 |
|---|---|---|
| 1 | 修复 `20260408170000_friend_activities` migration → 恢复 `migrate dev` | 工程化 |
| 2 | 统一 `Paginated<T>` 信封 + 响应信封 `code` 语义,friend 列表补分页 | 契约(需前端协调) |
| 3 | `RolesModule`:实现或删除;清理 casl 死装饰器 | 死代码 |
| 4 | 拆 `friend.service.ts` / `note.service.ts` | 可维护性 |
| 5 | env 解析收敛到 `ConfigService` | 一致性 |
| 6 | 计数器策略统一(playbook §4:倾向 `_count` 实时算) | 架构决策 |
| 7 | 合并 / 重建日志基础(request-id + 结构化) | 可观测性 |
| 8 | 开 `tsconfig` strict(专门分支) | 技术债 |
| 9 | 补 `openim` / `roles` / controller 测试 | 测试 |

---

## 7. Phase 9 总评

- **一致性的好面**:模块结构、`JwtGuard`、`ParseUUIDPipe`、`RequestWithUser`、Prisma 参数化、外部集成的 best-effort 模式 —— 横向看是统一的
- **一致性的弱面**:响应信封、分页、计数器、env 解析 —— 四个"每个模块各做各的"的点,需要一次性统一
- **工程化债**:`tsconfig` strict 关闭(最大单项)、migration 工具链坏、`openim/roles` 无测试、日志无 request-id
- **死代码面**:`RolesModule` 整体 stub、casl 三装饰器零调用、若干 schema 死字段(各 Phase 已记)
- **无新增 HIGH 安全问题** —— 跨模块层面无越权/注入/泄露;唯一的 HIGH 是 `tsconfig` 类型安全这个技术债

至此 **Phase 0-9 全部 review 完成**。下一步:`99-summary.md` —— 汇总全部 HIGH/MED、修复状态、剩余路线图。
