# Circle BE — Code Review 计划

> 目的:对 `circle_be` 后端进行一次系统性 production-readiness review,识别 bug、安全风险、缺失的边界保护,并给出可落地的修复。
> 范围:`main` 分支当前 HEAD 全量代码(非单次 commit diff)。
> 方法论基础:5 个边界模式(strict DTO / server-derived identity / transaction / throttle+idempotency / scrubbed exception filter),配合 NestJS landmine 表。

---

## 1. 项目概况(已盘点)

| 项 | 内容 |
|---|---|
| 技术栈 | NestJS 11 + Prisma 7 + PostgreSQL 16 + Passport JWT + Argon2 + Helmet + express-rate-limit |
| 代码量 | ~12,455 行 TS,12 个业务模块 |
| 数据模型 | `prisma/schema.prisma` 1133 行,~50 model + ~30 enum |
| 已有测试 | 28 个 `.spec.ts`(覆盖到大多数 service / dto / guard) |
| 全局基础设施 | `setupApp` 已配置 helmet、global ValidationPipe (`whitelist + transform`)、PrismaExceptionFilter、ResponseInterceptor、分路由 rateLimit |
| **未配** | ValidationPipe 没开 `forbidNonWhitelisted` / `disableErrorMessages`,无 idempotency 机制,无统一 AllExceptionFilter(被注释掉了),日志未脱敏 |

业务模块及规模:

| 模块 | service 行数 | 关注重点 |
|---|---:|---|
| `auth` | ~ (含 refresh-token.service) | 注册、登录、refresh token 轮换、CASL、casl-ability |
| `user` | 219 | profile、accountId、update normalization |
| `friend` | **1166** | 加好友 / 拉黑 / 标签 / 备注 / 举报 / activities — 最大、最复杂 |
| `coin` | 235 | 钱包、gift、交易 — 涉及金钱 |
| `note` | **854** | 笔记、多 group、多媒体 — 大文件 |
| `circle` | 453 | 圈子核心 |
| `circle-invitation` | 631 | 邀请审核流程 |
| `circle-plaza` | 240 | 广场 |
| `trace` | 390 | 动态、评论、点赞 |
| `upload` | 144 | S3 预签名、objectKey 归属校验 |
| `roles` | 27 | 角色管理 |
| `openim` | 196 | IM 集成 |

---

## 2. Review 目标 & 不目标

**目标**
- 找出可触发的 bug(空指针、并发竞争、数据不一致)
- 找出安全风险(IDOR、mass assignment、未鉴权、日志泄露、SSRF、注入)
- 找出缺失的 production 边界(校验、事务、限流、幂等、异常归一化)
- 找出可维护性问题(分层违规、巨型文件、重复逻辑)
- 给出最小化补丁建议(改边界,不重设计)

**不目标**
- 重构(除非现状直接导致 bug)
- 替换技术栈 / ORM
- 性能微调(除 N+1 / 明显阻塞外)
- 完整重写 schema

---

## 2.5 颗粒度要求(本次 review 关键约束)

**每个文件必须逐行通读**,不允许"看代码片段、按 grep 命中跳读"。具体执行规则:

1. **逐文件全文阅读**:模块内的 `.controller.ts` / `.service.ts` / `.module.ts` / `dto/*.ts` / `pipes/*.ts` / `__tests__/*.spec.ts` 每个文件,从 line 1 读到最后一行;长文件分块读但必须连续覆盖。
2. **逐行 annotation**:对每个文件,在 review 报告里列出"line-by-line notes" — 即使是 OK 的行也要标记"OK"或直接跳过段落(标记起止行号 + 一句说明),保证审计可追溯。
3. **每个 finding 必须挂到具体 line**:`file:line` 必填,不接受"在某 service 里"这种模糊定位。多行问题用范围 `file:line-line`。
4. **包含已通过的检查**:每个文件末尾要有 "Verified OK" 小节,列举跑过的检查(如:Body 都有 DTO 装饰 / 全部 service 调用都过 guard / 软删字段统一过滤),证明确实看过。
5. **细到 typo / 命名 / dead code / 注释失真**:LOW 级别也要记录,不删减。
6. **测试也算 review 对象**:每个模块的 `.spec.ts` 也要逐行,检查 mock 是否伪造了关键路径、是否漏掉负面 case、是否依赖被改后没更新。

### 单文件 review 子模板(嵌入每份模块报告中)

```markdown
### File: `src/<module>/<file>.ts` (NNN lines)

**Walkthrough(逐段)**
- L1–L20  imports / 类装饰  → OK / 问题
- L21–L45 字段定义           → OK / 问题
- L46–L80 method foo         → 详细分析
- ...

**Findings in this file**
- [HIGH] L67: <一句话>
- [MED]  L102: <一句话>
- [LOW]  L130: <一句话>

**Verified OK in this file**
- Guards 都已声明
- 所有 prisma 写操作都走事务
- 无 console.log / 无 process.env 直读
```

> 不能跳过任何一个 `.ts` 文件,包括看似简单的 `*.module.ts` 和 dto。

---

## 3. Review 方法论

每个模块走同一套 checklist。来源:`nestjs-production-review` skill 的 landmine 表 + 5 个边界模式。

### 3.1 Landmine 扫描表(每模块全文 grep)

| Landmine | 检测方式 |
|---|---|
| `@Body() body: any` / 未装饰 DTO | grep `@Body\(\)` 后类型 |
| DTO 含 `userId` / `tenantId` / `role` / `status` / `price` | grep DTO 字段名 |
| `findOne(id)` 后无 null check | grep `findUnique\|findFirst` 后接 `.` |
| 多 `.update / .create / .delete` 无 `$transaction` | grep `prisma.*\.update` 计数 |
| 敏感路由无 `@UseGuards(JwtAuthGuard)` | grep `@Controller` + 路由声明 |
| `console.log` / 直接打印 body / token | grep `console\.\|Logger.*body\|token` |
| HTTP 出站调用无 timeout/try-catch | grep `httpService\|fetch\|axios` |
| 缺 `Idempotency-Key`(钱包 / 礼物 / 邀请等副作用) | 看 coin / circle-invitation / note 关键写接口 |
| `throw new Error(...)` in service | grep `throw new Error` |
| controller 直接访问 prisma | grep controller 文件中 `prisma\.` |
| `for await` 串行 DB 调用 | grep `for.*await\|forEach.*await` |
| `process.env.X` 散落 | grep `process\.env\.` |

### 3.2 5 个边界模式核对

A. **Strict DTO + global ValidationPipe** — 当前缺 `forbidNonWhitelisted`,需提议加上。
B. **Server-derived identity** — 必须确认 user/circle/post owner 都从 token 取,不允许 body 传入。
C. **Transaction wrap** — coin 转账 / friend 接受请求 / circle 加入 / invitation 审核都必须事务。
D. **Throttle + idempotency** — auth/coin/friend/note 已有 IP rate limit;`coin/gift`、`circle-invitation 通过审核`、`note create` 这些会产生外部 / 持久副作用的需评估幂等。
E. **Normalized exception filter + scrubbed logger** — `AllExceptionFilter` 被注释掉,需评估是否启用并加 PII 脱敏。

### 3.3 Prisma 层独立检查项

- 软删 vs 硬删一致性(`deletedAt` 字段是否所有查询都过滤)
- 并发计数(like / view / member count)是否走原子 `increment` 或事务
- 唯一约束 + 业务校验是否双保险
- 索引是否覆盖热查询(注意 friend / trace / circle-post 列表场景)
- 外键 onDelete 策略

---

## 4. 分阶段 Review 计划

按 **风险 × 影响面** 排序,每个阶段产出一份 `reviews/NN-<module>.md`。

### Phase 0 — 基础设施 & 横切关注点(最先做,影响后续每模块)
**产出**: `reviews/01-infra.md`

- `main.ts`:CORS / Swagger 暴露范围 / 端口校验
- `setup.ts`:ValidationPipe 配置、helmet 头、rateLimit 策略覆盖度
- `app.module.ts`:ConfigModule、模块加载顺序、joi 校验完整性
- `config/env.validation.ts`:必填环境变量
- `filters/*`:被注释的 AllExceptionFilter、PrismaExceptionFilter 行为、错误响应是否泄露内部细节
- `interceptors/response.interceptor.ts`:响应包装、是否屏蔽敏感字段
- `guards/*`:Jwt / Admin / Role / CASL 守卫语义、`@CurrentUser` 装饰器实现
- 日志:winston 是否脱敏 password / token / phone / email

### Phase 1 — Auth & 用户身份(安全 P0)
**产出**: `reviews/02-auth-user.md`

- `auth/auth.controller.ts` + `auth.service.ts`:
  - 注册:accountId 生成、密码强度、Argon2 参数
  - 登录:失败次数、错误消息泄露(用户名存在性区分?)
  - refresh:`refresh-token.service` token 轮换、reuse detection、设备绑定
  - 登出:token 撤销范围(单设备 / 全设备)
  - change-password:旧密码校验、必须撤销其他 refresh token
- `auth.strategy.ts`:JWT secret 来源、过期处理
- `casl-ability.service.ts` + `casl.guard.ts` + `decorators/casl.decorator.ts`:权限边界
- `user/user.controller.ts` + `user.service.ts`:
  - update normalization 是否能改 role / status / accountId
  - public-user.dto 是否屏蔽 email/phone/refreshToken
  - 头像、profile 字段长度 / XSS 风险

### Phase 2 — Friend 模块(逻辑最复杂、1166 行,**拆为两份报告**)
**产出**: `reviews/03a-friend-core.md`(请求/状态机/事务)+ `reviews/03b-friend-aux.md`(标签/备注/举报/activities)

- 加好友状态机:`PENDING → ACCEPTED / REJECTED / BLOCKED` 转移正确性
- accept / reject 必须事务(双向 Friend 关系 + activity 记录)
- 拉黑:Block 与 Friend 是否互斥、是否同步关掉已有关系
- 标签 / 备注:owner 校验是否服务端从 token 推导
- 举报 friendReport:rate limit 已有,看 dedupe(同人多次举报)
- friend activities:写入是否漏一致性

> friend.service.ts 1166 行,逐行 review 必拆成 a/b 两份;controller / dto / spec 归到 03a 末尾或 03b 视具体规模分配。

### Phase 3 — Coin / 钱包(金钱 P0)
**产出**: `reviews/04-coin.md`

- `gift` 流程:
  - 必须事务(扣发送方 + 加收件方 + 写 CoinTransaction + 写 CoinGift + 触发 notification)
  - 余额 race condition(pessimistic lock / version)
  - 幂等(idempotency-key 或客户端 transactionId 去重)
- `Wallet` 初始化:并发 upsert 是否安全
- 余额溢出 / 负数防护(整型 / Decimal)
- CoinTransaction 是否只追加(append-only),不允许 update

### Phase 4 — Note(854 行 service,**拆为两份报告**)
**产出**: `reviews/05a-note-core.md`(create/update/visibility/group)+ `reviews/05b-note-media-list.md`(media、列表查询、计数、search)

- 笔记可见性 / 软删 / 分组成员校验
- multi-group 写入是否事务
- objectKey 归属校验(最近 commit `6f5481e` 已动过 — 重点 review)
- 媒体类型白名单 / 大小限制
- 内容 JSON 字段反序列化注入风险

### Phase 5 — Circle 三件套(circle / invitation / plaza)
**产出**: `reviews/06-circle.md`

- 创建 circle:owner 自动加入、初始 member role 正确性
- 加入流程:approval 模式下 invitation 与 member 同步事务
- invitation 审核(verifier):多 verifier 的状态聚合算法
- plaza:公共列表的过滤(隐藏 banned / private circle)
- circle-post:成员资格校验、点赞 / 评论的可见性

### Phase 6 — Trace(动态)
**产出**: `reviews/07-trace.md`

- visibility(PUBLIC/FRIEND/PRIVATE)在列表和详情两处都生效
- like / view 计数原子性
- UserTracePreference / Block 联动过滤
- 评论 reply chain 深度 / 防滥用

### Phase 7 — Upload(S3 预签名)
**产出**: `reviews/08-upload.md`

- presign 限制:content-type 白名单、size limit、过期时间
- objectKey 命名空间(必须含 userId,防止覆盖他人)
- 删除接口是否校验 owner
- `6f5481e` 提到 "relax objectKey ownership check" — **重点核对放宽是否过度**

### Phase 8 — OpenIM 集成
**产出**: `reviews/09-openim.md`

- 出站调用:timeout、retry、错误传播
- token / signature 是否泄露到日志
- IM 用户同步失败的回滚或补偿

### Phase 9 — 收尾:维护性 + 跨模块
**产出**: `reviews/10-cross-cutting.md`

- 重复逻辑(分页、owner check、软删过滤 → 是否可抽 helper)
- 巨型 service 拆分建议(friend 1166 / note 854 / circle-invitation 631)
- 错误码统一(目前消息都是字符串)
- Swagger 文档完整性
- 测试覆盖盲区(controller e2e、并发场景、负面 case)
- migration 历史中是否有破坏性变更未做数据回填

---

## 5. 单模块 review 模板(每份 `reviews/NN-*.md` 必含)

```markdown
# <模块名> Review

## 1. 范围
- 涉及文件 / 路由 / 数据模型

## 2. Findings
### 2.1 Confirmed Bugs        (file:line + 重现路径)
### 2.2 Security Risks         (file:line + 攻击场景)
### 2.3 Missing Safeguards     (5 个边界模式中哪些缺失)
### 2.4 Maintainability        (拆分 / 命名 / 重复)

## 3. Risk Prioritization
- HIGH / MEDIUM / LOW(校准标准见 plan §3.2)

## 4. Recommended Patches
- 每条:`file:line` + 简短修复策略

## 5. Tests to Add
- 关键失败路径的测试用例清单

## 6. Deferred
- 不在本轮范围 / 需要更大改动的项
```

---

## 6. 风险定级标准(全 review 统一)

| 级别 | 适用条件 |
|---|---|
| **HIGH** | 鉴权缺失 / 客户端可伪造 owner / 金额错误 / 事务缺失导致数据孤儿 / 日志泄漏 token / SQL 注入 / 未限流的登录/支付 |
| **MEDIUM** | 可选字段未校验 / 下游无超时 / 关键写无幂等 / N+1 / 异常 filter 漏栈 |
| **LOW** | `console.log` / 单文件 > 500 行 / 命名 / magic number / JSDoc 缺失 |

> 规则:HIGH finding 必须能描述出"什么情况下会发生、影响什么"。说不出场景 → 降级。

---

## 7. 输出物清单

```
reviews/
  00-review-plan.md          ← 本文档
  01-infra.md                ← Phase 0
  02-auth-user.md            ← Phase 1
  03a-friend-core.md         ← Phase 2 上半(请求/状态机/事务)
  03b-friend-aux.md          ← Phase 2 下半(标签/备注/举报/activities)
  04-coin.md                 ← Phase 3
  05a-note-core.md           ← Phase 4 上半(create/update/visibility/group)
  05b-note-media-list.md     ← Phase 4 下半(media/列表/计数/search)
  06-circle.md               ← Phase 5
  07-trace.md                ← Phase 6
  08-upload.md               ← Phase 7
  09-openim.md               ← Phase 8
  10-cross-cutting.md        ← Phase 9
  99-summary.md              ← 汇总 + HIGH/MEDIUM 总清单 + 修复路线图
```

> 共约 **13 份**报告。每份预期 600–2000 行 markdown(含 line-by-line walkthrough)。

---

## 8. 节奏建议

- 每个 Phase 一份独立报告,先**只输出 findings**,不直接改代码
- 全部 review 完成后,产出 `99-summary.md`,再按优先级分批提交修复 PR
- HIGH 项立即修;MEDIUM 入待办;LOW 在下次重构窗口处理

---

## 9. 下一步

确认本计划后,可从 **Phase 0(infra)** 开始执行。建议顺序严格按 Phase 编号,因为后续模块 review 会引用 infra 的结论(如全局 ValidationPipe 是否足够严格、guards 语义)。

**颗粒度承诺**:每份报告会逐文件逐行覆盖,findings 必带 `file:line`,文件末尾必带 "Verified OK" 清单,绝不跳读。

