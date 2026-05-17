# Phase 1 — Auth & User Review

> 范围:`src/auth/` 全部(controller / service / strategy / casl-ability / refresh-token + 7 DTO + 3 test 文件)和 `src/user/` 全部(controller / service / module + 5 DTO + pipe + 3 test 文件),加上 `src/utils/account-id.ts`、`prisma/schema.prisma` 的 `User` / `RefreshToken` 模型。
> 颗粒度:逐文件逐行。
> 依赖:本 Phase 假设 Phase 0 修复已落地(全局 ValidationPipe 已加 `forbidNonWhitelisted`,Pattern E AllExceptionFilter 已注册)。

---

## 0. TL;DR — 按严重度排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **HIGH** | `src/auth/auth.module.ts:21` | `signOptions: { expiresIn: '15m' }` 硬编码,无视 Phase 0 加入的 `JWT_EXPIRES_IN` env;同样 `REFRESH_TOKEN_TTL_DAYS = 7` 写死在 `refresh-token.service.ts:5` |
| 2 | **HIGH** | `src/user/user.service.ts:202-209` `remove` + `:211-218` `updateStatus` | 软删用户 / BAN 用户后**没调用 `refreshTokenService.revokeAll(id)`** — 被删/被封用户在 refresh token TTL(7d)内仍能拿新 access token |
| 3 | **HIGH** | `src/auth/auth.service.ts:163-187` `refresh` | 拿到新 token 时**不重检 `user.status`** — 已被 BAN / DELETED 的用户在 refresh token 没过期前可以无限续签 |
| 4 | **HIGH** | `src/user/dto/public-user.dto.ts:14-17` | `@Expose() username: string` 是死字段(User 模型根本没有 `username` 列);Swagger 文档 + 序列化都把它当真,客户端拿到永远是 `undefined`,且向 schema 漂移敞开 |
| 5 | **HIGH** | `src/auth/auth.service.ts:120-126` `login` | 用户不存在 → "Invalid credentials";用户存在但 inactive → "Account is not active" — **可枚举 accountId** 是否存在,配合 `/user/search/account` 形成双重 oracle |
| 6 | **HIGH** | `src/user/user.controller.ts:51-59` `/user/search/account` | 任意认证用户可以**精确匹配 + insensitive 模式**搜索 accountId;只有全局 300/min IP fallback,无端点级限流,无每用户配额 → 字典爆破账号枚举 |
| 7 | **MED** | `src/auth/refresh-token.service.ts:42-79` `rotate` | TOCTOU 已经修了,但**没有"refresh token reuse 检测"** — 旧 token 被旋转后再次使用时,只是 401,不会撤销整条 session chain。失窃 token 与合法用户并存 |
| 8 | **MED** | `src/auth/auth.controller.ts:34-44` + `RefreshToken` schema | `x-device-name` 头无长度上限,DB 字段 `RefreshToken.deviceName String?` 也无 cap → 一次 refresh 可写入 100KB device 名 |
| 9 | **MED** | `src/auth/auth.module.ts:34` | 只 `exports: [CaslAbilityService]`;`@Global()` 但不导出 `AuthService` / `RefreshTokenService`(其它模块若要 revoke session 拿不到 service) |
| 10 | **MED** | `src/auth/auth.service.ts:201-226` `me` | DB 出错时 `.catch` 返回**伪造**的 `lastOnline: now` 让请求成功 — 客户端看不到 DB 故障,silent failure |
| 11 | **MED** | `src/user/user.controller.ts:75-81` `getUser` | 任意认证用户可拿任意他人 profile,含 `wechat/qq/whatsup` 等社交账号 — 是否符合产品隐私要求待确认 |
| 12 | **MED** | `src/user/user.service.ts:132-146` `findAll` | `limit` 来自 query,未夹 max → 可 `?limit=1000000` 把库一次拉光(管理员路由,危害有限但易触发 OOM) |
| 13 | **MED** | `src/auth/auth.controller.ts:99-105` `logout` | 公开路由(无 JwtGuard),收受 raw refreshToken 解锁。功能上 OK,但**没有按用户 / 按 IP 限流**(只有全局 fallback) |
| 14 | **MED** | `src/auth/auth.controller.ts:120-127` `logoutAll` | 触发 `revokeAll` 后**当前的 access token 仍可活 ≤15m**;真正的 logout-all 需要 access token 黑名单或更短 TTL |
| 15 | **MED** | `src/auth/auth.service.ts:135-149` + `:96-110` | OpenIM 失败的非阻塞重试无 backoff、无失败次数上限,且 `openimSynced=false` 会让**每次 login 都触发一次失败的远调** |
| 16 | **MED** | `src/auth/refresh-token.service.ts:21-40` | `lastUsedAt` 只在 `create` 时写,`rotate` 把旧 token 设为 revoked 但**不更新 lastUsedAt**,新 token 又重置为 `now`(=create 时间) — 字段语义其实始终等于 `createdAt`,UI "上次使用" 完全不准 |
| 17 | **MED** | `src/auth/__test__/refresh-token.service.spec.ts` | 没测 `rotate` happy path(只测 invalid token),Phase 0 提到的 TOCTOU 修复实际上**没有覆盖测试** |
| 18 | **MED** | `src/auth/__test__/auth.service.spec.ts:62-66` | mock 用 `u.username` 比对(老 schema 残留),被第二处 mockImplementation 覆盖才没出问题 — 但测试根本没在保护这一行 |
| 19 | **MED** | `src/user/user.service.ts:177-190` `create` | 接受 `email/phoneNumber` 入参,但 `CreateUserDto`(给 controller 用)不包含,字段悬空;且 email/phone **无唯一约束**,多个账号可共用同一邮箱 |
| 20 | LOW | `src/auth/auth.strategy.ts:17` | `validate(payload: any)` — 应该用 `JwtPayload` 类型;无 token 黑名单回写 |
| 21 | LOW | `src/auth/casl-ability.service.ts` | TODO 注释 + 仅 Admin 一类 ability,等于把 CASL 当 admin flag 用 |
| 22 | LOW | `src/auth/dto/signin-user.dto.ts` | 完整冗余,与 `LoginDto` 唯一区别是中文错误信息,实际 controller 用 LoginDto;死代码 |
| 23 | LOW | `src/auth/dto/refresh-token.dto.ts:5-11` | `REFRESH_TOKEN_LENGTH=128` 把 token 长度硬编码到 DTO,如果后端改 `randomBytes(N)` 就会单边失效 |
| 24 | LOW | `src/auth/auth.controller.ts:117,125,135,150` | 多处 `@Req() req: any`,丧失类型推导,可换 `RequestWithUser` 类型别名 |
| 25 | LOW | `src/user/pipes/create-user.pipe.ts` | no-op pipe `return value`,完全可删 |
| 26 | LOW | `src/user/user.controller.ts:79` | `@Param('id') id: string` 无 UUID 校验;畸形 id 会触发 Prisma 错误,被 PrismaExceptionFilter 兜底但响应不友好 |
| 27 | LOW | `src/utils/account-id.ts:5-11` | `randomBytes(6) % 36` 有微弱偏置(256 mod 36 != 0,前 28 个字符出现概率 +1/256) — 8 位 base36 仅 ~41 bits,碰撞测试不充分 |
| 28 | LOW | `src/auth/dto/register.dto.ts:21` | `password Length(6,64)` 无复杂度要求;argon2 用默认参数(实践 OK),但建议显式 pin |
| 29 | LOW | `src/user/dto/update-user.dto.ts:22` 与 `register.dto.ts:27` | nickname 一个 `MaxLength(50)`、一个 `Length(1,30)` — 不一致 |
| 30 | LOW | `src/user/dto/public-user.dto.ts:34-44` | `wechat`/`qq`/`whatsup` 写在 `PublicUserDto`(非 `SelfUserDto`),所有人可见。请 confirm |
| 31 | LOW | `src/user/user.service.ts:67-87` `normalizeBirthdayInput` | `new Date(normalized)` 接受 `"foo"` → `Invalid Date`(Prisma 写入会失败);应改 `IsDateString` 在 DTO 层兜底(实际上已有,但 service 端再做一次 normalize 时再次冒险) |
| 32 | LOW | `src/auth/auth.controller.ts:116-118` `sessions` | `Serialize(AuthSessionDto)` 没装,返回原始 prisma 结果(只是 select 限定列),Swagger 类型与实际值有可能漂移 |
| 33 | LOW | `src/user/__tests__/user.service.spec.ts:10-12` | mock 只覆盖 `findFirst`,其它方法在 service 里直接 `prisma.user.xxx` 没被测过;`user.controller.spec.ts` 同样大量未测路径 |
| 34 | LOW | `src/auth/dto/auth-tokens.dto.ts:15` | `imToken: string` 必填但代码层 fallback 是 `''`(`.catch(() => '')`) — Swagger 标 required 但实际为空字符串,前端断言可能误判 |
| 35 | LOW | `src/auth/auth.service.ts:84` | `argon2.hash(dto.password)` 没传 options,argon2 默认是 argon2id,iterations=3,parallelism=4,memoryCost=65536 — 对登录敏感系统建议显式配置 |
| 36 | LOW | `src/user/user.controller.ts:46-49` `getUsers` | 返回 envelope `{ data, total, page, limit }` 与 `ResponseInterceptor` 的 `{ code, message, data }` 嵌套两层,前端拿到 `data.data.data` |
| 37 | LOW | `src/auth/refresh-token.service.ts:13-15` | `hashToken` SHA-256 hex,无 keyed hash(HMAC) — 即使 DB 被偷,SHA-256 hash 不可逆,但配合彩虹表略危险;128 hex 输入空间足够大,在用攻击下 OK |
| 38 | LOW | `src/auth/auth.module.ts:34` `exports: [CaslAbilityService]` | 但 `casl.guard.ts` 在 `src/guards/`(非 auth module 直接 register),它注入 `CaslAbilityService` 全靠 `@Global()`。耦合关系隐式 |

总计 **38 项**:HIGH 6、MED 13、LOW 19。

---

## 1. File: `src/auth/auth.module.ts` (37 lines)

### Walkthrough
- **L1–11** imports — ok
- **L13** `@Global()` — 一处问题:auth 模块全局化但只导出 `CaslAbilityService`,其它任何"想撤销用户 session"的服务都拿不到 `RefreshTokenService`(见 #9)
- **L15–26** `JwtModule.registerAsync`:
  - L19 `useFactory: async (configService: ConfigService) => ({...})` — 同步即可,没必要 async,但无害
  - L20 `secret: configService.get<string>(ConfigEnum.SECRET)` — 返回 `string | undefined`。env.validation 保证存在,但类型层失语
  - **L21 `signOptions: { expiresIn: '15m' }` — 🔴 HIGH-#1**:Phase 0 新增的 `JWT_EXPIRES_IN` env 在这没用到。env 的 default `'1h'` 与代码的 `'15m'` 也不一致 — 实际运行时谁赢?**代码赢**,env 是哑设
  - L23 `inject: [ConfigService]` ok
- **L27–32** providers 完整
- **L33** controllers 完整
- **L34 `exports: [CaslAbilityService]`** — 见 TL;DR #9。`RefreshTokenService` 没导出 → user.service 里要撤 session(见 fix #2/#3)就拿不到。建议加 `RefreshTokenService`
- **L36** end

### Findings
- [HIGH-1] L21: expiresIn 硬编码
- [MED-9] L34: 缺 `RefreshTokenService` 在 exports
- [LOW] L19: `async` 无必要

### Verified OK
- 用 `forRootAsync` 拿 ConfigService(没用 `JwtModule.register({ secret: process.env.SECRET })` 这种坏模式)
- PassportModule + JwtStrategy 都装好
- OpenimModule 引入(为 register/login flow)

---

## 2. File: `src/auth/auth.controller.ts` (153 lines)

### Walkthrough
- **L1–25** imports + `SessionContext` 类型从 refresh-token.service 引入 ok
- **L27–32 `getHeaderValue`** — 提 array 第一项,字符串原样,缺失 null。OK
- **L34–44 `getSessionContext`** —
  - L36 `if (!req) return {}` 友好
  - L40 `req.headers['x-device-name']` 取出后 **没截长**(见 TL;DR #8)
  - L41 `requestIp.getClientIp(req) ?? req.ip ?? null` — 双兜底,ok。`request-ip` 库会按 X-Forwarded-For 等 header 优先,**生产环境若代理不可信会取错 IP**(扩展话题:`app.set('trust proxy', ...)` 没设)
  - L42 `req.headers['user-agent']` — UA 没截长,典型 UA 几百字符内,但理论无限制
- **L46–49** Controller 装饰 + ctor — ok
- **L51–65 `POST /register`** — `@Body() dto: RegisterDto`;无 JwtGuard(对);返回 `authService.register(dto, ctx)`
- **L67–81 `POST /login`** — 同上
- **L83–97 `POST /refresh`** —
  - L96 `dto.refreshToken` 转给 service。**`@Length(128,128)` DTO 强校验确保是 128 hex 字符串**(ok)
- **L99–105 `POST /logout`** —
  - 🟡 **MED-13**:**没有 `@UseGuards(JwtGuard)`**(注释/装饰上没有);任何能持有一个有效 refreshToken 的人都能 revoke 它。其实这是合理的(自助退出),但意味着 logout 是 unauthenticated endpoint,没有端点级限流。是否要求登录态再 logout 视产品规约
- **L107–118 `GET /sessions`** + JwtGuard + Bearer auth + 返回 `AuthSessionDto[]`
  - L117 `req.user.userId` — 与 strategy validate 返回的 `userId` 字段对应(注意:JWT payload 里是 `sub`,strategy 把 `sub` 映射成 `userId`)
  - 🟡 **LOW-32**:`isArray:true` Swagger,但没有 `@Serialize(AuthSessionDto)` 装饰 → 实际返回 prisma raw 对象(select 已限定列,所以字段是对的,但若以后 select 改了就会泄漏)
- **L120–127 `POST /logout-all`** + JwtGuard
  - L126 `req.user.userId` 同上
  - 🟡 **MED-14**:返回后,**当前请求所用的 access token 还能用 ≤15m**。是否符合"全设备登出"语义需要 PM 拍板;若严格,需引入 access token 撤销列表(Redis blacklist)
- **L129–141 `POST /change-password`** + JwtGuard
  - L137 `req.user.userId`、L138-139 dto.oldPassword/newPassword
  - service 内部已 `revokeAll(userId)` — ✅
- **L143–152 `GET /me`** + JwtGuard + `@Serialize(SelfUserDto)`
  - 返回 SafeUser → SelfUserDto 序列化 → 包含 email/phoneNumber

### Findings
- [MED-13] L99–105: logout 无 JwtGuard,无端点级限流
- [MED-14] L120–127: logoutAll 不撤销当前 access token
- [MED-8] L40: x-device-name 不截长(配合 schema 无 cap)
- [LOW-24] L116, L125, L135, L150: `@Req() req: any` 多处
- [LOW-32] L113: sessions 没 `@Serialize`
- [LOW] L41: trust proxy 未配置,client IP 易被伪造

### Verified OK
- 所有需要登录的端点都装了 `@UseGuards(JwtGuard)`
- `@ApiBearerAuth` 与 guard 一致
- `getSessionContext` 把 device/IP/UA 装进 RefreshToken,便于 sessions 列表查看

---

## 3. File: `src/auth/auth.service.ts` (277 lines)

### Walkthrough — 分块

**L1–15 imports**
- `argon2` 默认参数(见 LOW-35)
- `Logger` 来自 nest

**L17–39 `ME_SELECT`** — 列名白名单(用 `as const`)。包含 email/phoneNumber、wechat、qq、whatsup、persona、helloWords、birthday、gender、city、role、status、lastOnline。**符合 SelfUserDto** 字段集合

**L41–63 `SafeUser` type** — 手写,与 `User` Prisma 模型耦合;每加字段都要双更
- LOW:可用 `Prisma.UserGetPayload<{ select: typeof ME_SELECT }>` 自动派生

**L65–74 ctor** — Logger + 4 个依赖

**L76–113 `register(dto, sessionContext?)`** —
- L77–82 重复 accountId → `ConflictException`(此外 Prisma `@unique` 也会兜)
- L84 `argon2.hash(dto.password)` 默认参数(LOW-35)
- L86–94 create user,使用 dto.email/phoneNumber 直入;status default ACTIVE;role default USER(在 schema)
- L98–110 **OpenIM register fire-and-forget**:成功 → 写 `openimSynced=true`;失败 → 只 warn
  - 🟡 MED-15:无重试上限、无失败次数计数。OpenIM 永久挂时,这条 promise 每次都跑
- L112 `return issueTokens(...)` — 三 token 并发签发

**L115–161 `login(dto, sessionContext?)`** —
- L116 findUnique by accountId(注意是大小写敏感的精确匹配 — 与 `findByExactAccountId` 的 insensitive 不一致 → 注册时大小写正确,登录时也必须大小写正确,**容易让用户困惑**)
- L120–122 user 不存在 → `ForbiddenException('Invalid credentials')`
- L124–126 status !== 'ACTIVE' → `ForbiddenException('Account is not active')`
  - 🔴 **HIGH-5**:对**已存在但 inactive** 的账号给出不同消息,与"不存在"区分开 → enumeration
- L128–131 argon2.verify 失败 → `ForbiddenException('Invalid credentials')` ✅
- L135–149 OpenIM 重试同 register
- L152–158 lastOnline 异步 update,失败仅 warn

**L163–187 `refresh(refreshToken, sessionContext?)`** —
- L164–165 `rotate(refreshToken, sessionContext)` — 拿到新 token 与 userId
- L167–170 findUnique by id;**不存在抛 404**
- L172–179 lastOnline 异步
- L181–186 sign access + return
- 🔴 **HIGH-3**:这里**不检查 `user.status`** — 一个 BANNED/DELETED 用户只要还有有效 refresh token 就能无限续签。可重现:
  1. 用户登录 → 拿到 refresh token
  2. 管理员封号 (`updateStatus(id, BANNED)`)
  3. 用户用旧 refresh token 调 `/refresh` → 拿到新 access token(因为本服务没 revoke session — 见 HIGH-2)→ 继续访问 API

**L189–195 `logout` / `sessions`** — 直接转发

**L197–199 `logoutAll`** — 直接转发

**L201–226 `me(userId)`** —
- L202–209 findUnique + select;不存在抛 404
- L213–225 `prisma.user.update` 写 lastOnline,**`.catch` 返回伪造对象** `{ ...user, lastOnline: now }`
  - 🟡 **MED-10**:silent 故障 — 当 DB 在 prisma.update 这一步抛(例如连接池满、唯一约束、事务回滚)用户仍然看到正常 `me` 响应。运维端只是看到 warn。建议:要么改为读后 fire-and-forget 写,要么把 DB 错传出去

**L228–251 `changePassword(userId, oldPassword, newPassword)`** —
- L233–236 找用户;404 兜底
- L238–241 verify oldPassword
- L243 hash newPassword
- L244–247 update passwordHash
- L250 `refreshTokenService.revokeAll(userId)` ✅

**L253–268 `issueTokens(userId, accountId, role, sessionContext?)`** —
- L259–266 `Promise.all([sign, createRefresh, openim.getUserToken.catch('')])` —
  - imToken 失败回 `''`,客户端拿到 `''` 自己判断
  - 🟡 LOW-34:Swagger DTO 字段标了必填,但实际可能是空 string

**L270–276 `signAccessToken`** — `this.jwt.signAsync({ sub: userId, accountId, role })` — 注意 **payload 含 role**,如果后续 admin 把用户 demote 到 USER,access token 里的 role 在到期前仍是 ADMIN

### Findings
- [HIGH-3] L163–187: refresh 不重检 user.status
- [HIGH-5] L120–126: 双消息差异可枚举用户存在
- [MED-10] L213–225: me 静默掩盖 DB 故障
- [MED-15] L98–110, L135–149: OpenIM 重试无上限/无 backoff
- [LOW-35] L84: argon2.hash 无显式参数
- [LOW] L116 vs `findByExactAccountId`: 大小写敏感性不一致
- [LOW] L275: access token 里的 role 不能即时降权

### Verified OK
- changePassword 后 `revokeAll` ✅
- 注册/登录使用 argon2(不是 bcrypt 或 plain SHA)
- token 三并发签 (`Promise.all`) 而非串行 — 性能 OK
- 不在响应里返回 passwordHash(用 `select` 白名单)
- catch openim 失败的日志只 warn 不抛
- refresh token rotation 走 service(不在这里做)

---

## 4. File: `src/auth/auth.strategy.ts` (25 lines)

### Walkthrough
- **L1–5** imports
- **L7–24** `JwtStrategy extends PassportStrategy(Strategy)`
- **L9** ctor 用 `protected configService` — `protected` 多余,基类不需要;改 `private` 等价
- **L10–14 super({...})**:
  - L11 `jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken()` ✅(只从 Authorization header,不接受 query 或 cookie)
  - L12 `ignoreExpiration: false` ✅
  - L13 `secretOrKey: configService.get<string>(ConfigEnum.SECRET)` — 可能 undefined(虽然 env validation 兜)
- **L17–24 `validate(payload: any)`** —
  - `payload: any` 应该是 `JwtPayload`(自定义)
  - 不去 DB 拉用户、不查 status — `validate` 完全靠 payload 自描述
  - 也没有 token 撤销名单(配合 HIGH-3,这是为什么 BAN 完用户不立即生效:guard 只解 JWT 签名,不看 DB)

### Findings
- [LOW-20] L17: `payload: any`,无 JwtPayload type
- [LOW] L13: `secretOrKey` 类型为 undefined-bearing 不报错(passport 接受 undefined,登录态不会成立但是 silent)
- [LOW] 无 session 状态校验 — JWT 完全自描述

### Verified OK
- 只从 Authorization 头取 token(不从 query)
- ignoreExpiration: false
- 不在 validate 里访问 DB(性能 OK,但同时也意味着 ban 不能即时生效 — 见 HIGH-2/3)

---

## 5. File: `src/auth/casl-ability.service.ts` (15 lines)

### Walkthrough
- 仅一条规则:role === Admin → `can('manage', 'all')`
- 普通 USER 拿到的 ability 是空的(没任何 can / cannot)
- TODO 注释提到要重做 — 当前等于 admin flag

### Findings
- [LOW-21] L5: TODO 标记,实质未实现
- [LOW] L8: 函数名 `forRoot` 与生命周期 hook 同名,易混淆,建议 `for(role)`

### Verified OK
- Admin 全权;非 Admin 默认无权(配合 CaslGuard 默认 deny)

---

## 6. File: `src/auth/refresh-token.service.ts` (117 lines)

### Walkthrough
- **L1–4** imports — ok
- **L5 `const REFRESH_TOKEN_TTL_DAYS = 7;`** — 🔴 HIGH-1(配套):硬编码,无 env 控制
- **L7–11** `SessionContext` type — `{ deviceName?, ip?, userAgent? }`,字段都 `null` ok
- **L13–15 `hashToken(token)`** — SHA-256 hex digest
  - LOW-37:非 keyed hash;如果 DB 表泄露 + 攻击者预先知道 token 字典,可以 lookup。token 是 128-hex(512 bit)随机串,这种攻击不现实
- **L17–19** Injectable + ctor
- **L21–40 `create(userId, context?)`** —
  - L22 `randomBytes(64).toString('hex')` → 128 hex 字符,256 bit 熵 ✅
  - L23 sha256 哈希后只把 hash 存 DB
  - L24–25 expiredAt = now + 7d(硬编码)
  - L27–37 insert,带 deviceName/ip/userAgent,`lastUsedAt: new Date()`
  - L39 return 原始 token(只此一次返回明文给客户端)
- **L42–79 `rotate(oldToken, context?)`** —
  - L46 hash oldToken
  - L49–56 **`updateMany({ where: { token: tokenHash, revokedAt: null, expiredAt: { gt: now } }, data: { revokedAt: now } })`** — 这是 Phase 0 注释里强调的 TOCTOU 防护:**只有把同一行从 unrevoked → revoked 的那一个 race 会成功**(`updateMany` 返回 count=1)
  - L58–60 count === 0 → 401
  - L63–67 取出 record(只为拿 deviceName/ip/userAgent,作为新 token 的默认上下文)
  - L68–71 unreachable 兜底
  - L73–77 `this.create(record.userId, { ...request override or carry over })`
  - L78 return
  - 🟡 **MED-7**:**reuse 检测缺失** —
    - 场景:攻击者偷了用户的 refreshToken X。用户先用 X 调 /refresh → X.revokedAt=now,新 Y 发给用户。攻击者然后用 X 再调 /refresh → `updateMany` 找 `revokedAt:null` 匹配 0,401。
    - 当前行为:仅 401 一次。
    - 应有行为:**检测到 X 已 revoked → 把 X 关联的 session chain 整体 kill**(即 revoke 那个 userId 的所有 active sessions)。OAuth 2.0 best practice。否则用户拿着 Y 继续用,攻击者也能再偷下一次。
- **L81–87 `revoke(token)`** — 单 token 撤销,直接 updateMany
- **L89–109 `listActiveSessions(userId)`** — 取未撤销未过期的;orderBy lastUsedAt desc
  - 🟡 MED-16:`lastUsedAt` 实际从未被更新过(create 时设,rotate 不会更新旧 token 的它),所以 UI 永远是 createdAt 顺序
- **L111–116 `revokeAll(userId)`** — `updateMany { userId, revokedAt: null }` 全置 revoked。OK

### Findings
- [HIGH-1] L5: TTL 硬编码
- [MED-7] L49–56: 无 reuse detection
- [MED-16] L21, L42: lastUsedAt 字段语义形同虚设
- [LOW-37] L13–15: 非 HMAC hash

### Verified OK
- `randomBytes(64).toString('hex')` 256-bit 熵
- DB 只存 hash,明文只返回一次
- TOCTOU prevention via `updateMany({revokedAt: null}) + count check`
- `expiredAt: { gt: now }` 在所有 rotate / list 中都过滤过期

---

## 7. File: `src/auth/dto/register.dto.ts` (40 lines)

### Walkthrough
- accountId: `@IsString @IsNotEmpty @Length(4,32)` — ok,但**未限制字符集**(`[a-zA-Z0-9_]` 之类)。理论上可注册 emoji 账号
- password: `@Length(6,64)` — LOW-28 无复杂度
- nickname: 可选, `@Length(1,30)`(LOW-29 与 update DTO 不一致)
- email: `@IsEmail()` ok
- phoneNumber: `@MaxLength(20)` 无格式校验

### Findings
- [LOW-28] L21: password 无复杂度
- [LOW-29] L27: nickname 长度 30 vs UpdateUser 的 50
- [LOW] L13–16: accountId 无字符集白名单
- [LOW] L37–39: phoneNumber 无格式

### Verified OK
- 所有字段都加 class-validator
- email/phone 都 optional

---

## 8. File: `src/auth/dto/login.dto.ts` (16 lines)
- 与 register 一致 accountId+password,无 issue,ok

## 9. File: `src/auth/dto/change-password.dto.ts` (16 lines)
- old/new 都 `@Length(6,64)`,与 register 一致 ok
- 缺 `newPassword !== oldPassword` 校验(可在 service 加)

## 10. File: `src/auth/dto/refresh-token.dto.ts` (13 lines)
- `@Length(128,128)` 硬编码 — LOW-23

## 11. File: `src/auth/dto/auth-session.dto.ts` (24 lines)
- 仅 ApiProperty,无 class-validator(只用作响应类型)
- 所有可空字段都用 ApiPropertyOptional ✅

## 12. File: `src/auth/dto/auth-tokens.dto.ts` (16 lines)
- imToken **必填** 但服务端可能给 `''` — LOW-34

## 13. File: `src/auth/dto/signin-user.dto.ts` (15 lines)
- LOW-22:死代码;LoginDto 是真正在用的

## 14. File: `src/auth/dto/register.dto.spec.ts` (15 lines)
- 仅 1 case:nickname 可省。**缺**:invalid email、超长 accountId、短 password、缺 accountId — 全部 negative case

---

## 15. File: `src/auth/__test__/auth.controller.spec.ts` (110 lines)

### Walkthrough
- L11–14 mockTokenPayload(无 imToken)
- L16–59 mockAuthService — partial
- L74–82 register 测试 — 只检查返回值相等;**没断言** mock 被调用,没断言传给 service 的 dto 是什么
- L84–93 login/refresh 同上,薄
- L96–103 sessions:断言 length=1
- L105–109 logoutAll:断言 mock 被调

### Findings
- [LOW] 缺 changePassword、logout、me、register-with-conflict 等 case
- [LOW] register 测试不传 `Req` 第二个参数 — controller 当前签名 `@Req() req?: Request` 是可选,通过;但接口若收紧就会破

## 16. File: `src/auth/__test__/auth.service.spec.ts` (302 lines)

### Walkthrough
- **L11–48 mocks**:
  - `mockPrisma.user.findUnique` 在 L18 用 `where.accountId || where.id`(对的)
  - 但 **L62–66 beforeEach 又 mockImplementation** 用 `u.username` —— stale schema 残留
  - 这两段一前一后,后者赢,所以测试没炸,但意图是糟糕的
- L116–139 register 两 case
- L141–202 login 三 case + 一 session metadata
- L204–212 sessions
- L214–218 logoutAll
- L220–244 refresh
- L246–301 me

### Findings
- [MED-18] L62–66: stale `u.username` mock
- [LOW] 缺 register conflict 路径里 OpenIM mock 的 assertion(register 成功路径才有)
- [LOW] 缺 changePassword 测试
- [LOW] 缺 me 404
- [LOW] 缺 login 时 user.status='BANNED' 的 ForbiddenException

### Verified OK
- 用 argon2 实际 hash + verify(不仅是 mock)
- session metadata forward 路径被覆盖

## 17. File: `src/auth/__test__/refresh-token.service.spec.ts` (144 lines)

### Walkthrough
- create 写元数据 ✅
- list 只活跃 ✅
- revokeAll ✅
- **rotate 只测了 `invalid token → reject`** — 🟡 **MED-17**:
  - 没测 happy path(旋转后新 token 拿到、旧 token 二次使用立刻 401)
  - **没测 TOCTOU race** — 即 Phase 0 注释里强调的"两并发 rotate,只一个赢"也没覆盖

### Findings
- [MED-17] 缺 rotate 关键测试
- [LOW] 没测 expiredAt 已过的 token 被拒
- [LOW] 没测 revoke 单 token

---

## 18. File: `src/user/user.module.ts` (13 lines)
- `@Global()`,exports UserService。OK

## 19. File: `src/user/user.controller.ts` (118 lines)

### Walkthrough
- **L33–37** Controller 装饰
  - `@UseGuards(JwtGuard)` 套**类级别** ✅ — 所有路由默认要登录
  - `@ApiBearerAuth()` ✅
- **L40–49 `GET /user`** + `@UseGuards(AdminGuard)` ✅
  - 注意 Nest guard 是叠加的:JwtGuard (类) + AdminGuard (方法) 都要过
- **L51–59 `GET /user/search/account`** —
  - 🔴 **HIGH-6**:**只过 JwtGuard,任何登录用户可遍历搜账号**
  - `@Query('accountId') accountId: string` — 没装 DTO 校验,任意字符串都可
  - 实际 service `findByExactAccountId` 是精确匹配(equals+insensitive),所以不能模糊搜,但**可枚举**
  - 与 login 的 HIGH-5 oracle 叠加,可批量做账号字典 / 撞库
- **L61–73 `POST /user`** + AdminGuard ✅ + Serialize(PublicUserDto)
- **L75–81 `GET /user/:id`** + Serialize(PublicUserDto)
  - 🟡 MED-11:任意登录用户能拿任意他人完整 profile(含 wechat/qq/whatsup)
- **L83–96 `PATCH /user/:id`** —
  - L92 ownership check `id !== req.user?.userId && req.user?.role !== Role.Admin` → 403
  - **隐患**:Admin 可写任意他人 profile,**但没 audit log**
  - DTO `UpdateUserDto` 不含 role/status,加上 Phase 0 `forbidNonWhitelisted` 双保险 ✅
- **L98–106 `PATCH /user/:id/status`** + AdminGuard ✅
  - 🔴 **HIGH-2**:status 改 DELETED/BANNED 后**不触发 session revocation**
- **L108–117 `DELETE /user/:id`** —
  - L113 同 ownership 检查
  - `userService.remove(id)` 软删
  - 🔴 **HIGH-2**:同样不撤 session

### Findings
- [HIGH-6] L51-59: account search 无每用户限流
- [HIGH-2] L98-106, L108-117: 状态变更后无 token revocation
- [MED-11] L75-81: 任意用户看任意 profile(含社交账号)
- [LOW-26] L79, L89, L104, L112: `@Param('id')` 无 UUID 校验
- [LOW-36] L46-49: 分页响应被 ResponseInterceptor 再裹一层,前端要拆双层

### Verified OK
- 类级 JwtGuard,默认登录
- AdminGuard 在敏感写路由都装了
- ownership check 在 update / delete 路径都有
- Serialize 装饰统一使用 PublicUserDto / SelfUserDto

---

## 20. File: `src/user/user.service.ts` (219 lines)

### Walkthrough — 关键段

**L12–16 URL_FIELDS** — 用 typeof 派生类型字段名,OK

**L18–41 接口定义** — `CreateUserInput`(含 email/phoneNumber)与 `UpdateUserInput`(完整 profile 字段集)

**L43–65 PUBLIC_SELECT** — 完整白名单 22 字段;**未列 passwordHash / refreshTokens / 各种关系字段** ✅

**L67–87 `normalizeBirthdayInput`** —
- L67 `undefined` → undefined(不动)
- L72 `null` → null
- L78 `''` 修剪后空 → null
- L82–84 `YYYY-MM-DD` 严格匹配 → `new Date('YYYY-MM-DDT00:00:00.000Z')`
- L86 否则 `new Date(normalized)` — **可生成 Invalid Date** 写库,LOW-31
  - DTO `@IsDateString` 已经在 controller 层把字符串校验过,所以这里几乎不会到 L86 的坏路径,但 service 层应该也防御

**L89–98 `normalizeUpdateInput`** — 只处理 birthday

**L100–109 ctor** — 拿 `MINIO_PUBLIC_URL` 一次性 cache

**L111–130 `assertUrlsAreSafe`** — 三段
- L119 `if (!this.minioPublicUrl) return;` — **MINIO 未配时整个 SSRF 校验跳过**
- L121 `prefix = this.minioPublicUrl.replace(/\/$/, '')`
- L122–128 遍历 avatarUrl/avatarFrame/cover,若不以 prefix 开头 → 400
- ✅ 防止用户把 `http://169.254.169.254/...`(AWS metadata)或 `data:`/`javascript:` 当成头像存进 DB(`@IsUrl` DTO 层已挡 `javascript:`,这里是双保险)
- 🟡 一个绕过:如果 `MINIO_PUBLIC_URL=http://10.0.0.195:9000` 而攻击者拿到 `http://10.0.0.195:9000.attacker.com/foo` → startsWith 通过。**应该校验完整 URL host 而非纯字符串 startsWith**。建议:解析 URL 比较 origin

**L132–146 `findAll(query)`** —
- L133 destruct `limit = 10, page = 1, accountId`
- L134 `take = limit` — **无上限**(MED-12)
- L135 skip
- L136 where = accountId ? { contains } : undefined — 模糊匹配。**列 + contains** 在大表上是顺序扫
- L140–143 并发 findMany + count
- L145 envelope `{ data, total, page, limit }` — LOW-36

**L148–166 `findByExactAccountId(accountId?)`** —
- L149 `if (!accountId) return null`
- L150–154 trim+空检查
- L156–165 findFirst with `equals: normalized, mode: 'insensitive', status: ACTIVE`
- ✅ 只返回 ACTIVE 用户
- 🔴 配合 HIGH-6 任意人可调

**L168–175 `findOne(id)`** —
- findUnique + select + 404 — ok

**L177–190 `create(input)`** —
- argon2.hash(password)
- create user,nickname || accountId
- 不查 accountId 是否重复(靠 DB unique,P2002 → PrismaExceptionFilter 409)
- 🟡 MED-19:`email/phoneNumber` 在 input 里有,但 CreateUserDto(controller 实际传) 没有这两个字段 → 永远 undefined

**L192–200 `update(id, input)`** —
- assertUrlsAreSafe → findOne(存在性 + 404)→ prisma.update
- normalizeUpdateInput 处理 birthday
- 🟡 **隐患**(已被 forbidNonWhitelisted 挡):若 input 含 `passwordHash` / `role` / `status` / `id`,会被 ValidationPipe 拒。✅
- 🟡 但 service 层独立调(如其它 service 直接 call `userService.update(id, { role: 'ADMIN' })`)就**没有 DTO 拦截了** — service 层应该也有 allowlist。LOW

**L202–209 `remove(id)`** —
- findOne(404 兜底)→ update status=DELETED
- 🔴 **HIGH-2**:**不撤 session**
- 🟡 同时不应让 DELETED 用户的好友/circle 关系自动消失 — 走单独 cron / lazy 过滤,但目前未见

**L211–218 `updateStatus(id, status)`** —
- 同 HIGH-2

### Findings
- [HIGH-2] L202-218: 不撤 session
- [MED-12] L132-146: limit 无 max
- [MED-19] L177-190: email/phone 死路径
- [MED] L111-130: assertUrlsAreSafe 用 startsWith 而非 URL origin 比较
- [LOW-31] L86: `new Date(any)` 接受畸形
- [LOW] L192-200 service 层无字段白名单

### Verified OK
- PUBLIC_SELECT 不含 passwordHash
- argon2.hash 用于 create
- normalizeBirthdayInput 覆盖 undefined/null/空字符串三种语义
- findByExactAccountId 限 status=ACTIVE
- update/remove 前都做 findOne 拿 404

---

## 21. File: `src/user/dto/create-user.dto.ts` (22 lines) — ok

## 22. File: `src/user/dto/get-user.dto.ts` (27 lines) —
- page/limit `@IsInt @Min(1)`;**无 max** → MED-12 来源

## 23. File: `src/user/dto/update-user.dto.ts` (96 lines) —
- 所有字段都 `@IsOptional` + 类型校验
- nickname `MaxLength(50)`(LOW-29)
- avatarUrl/Frame/cover `@IsUrl({require_protocol:true, require_tld:false})` — 与 `assertUrlsAreSafe` 双保险
- birthday `@IsDateString` ✅
- gender `@IsEnum(Gender)` ✅
- city `MaxLength(100)` ✅

## 24. File: `src/user/dto/update-user-status.dto.ts` (9 lines)
- 只有 status `@IsEnum(UserStatus)`,ok

## 25. File: `src/user/dto/public-user.dto.ts` (99 lines)
- 🔴 **HIGH-4**:L14-17 `@Expose() username: string` — 模型无此字段;每个客户端拿到 `{ username: undefined, ... }`,Swagger 撒谎
- L34–44 social handles (wechat/qq/whatsup) 在 PublicUserDto 而非 SelfUserDto — 隐私决策(LOW-30 / MED-11)
- SelfUserDto extends PublicUserDto + email + phoneNumber ✅

## 26. File: `src/user/dto/update-user.dto.spec.ts` (17 lines)
- 1 case:接受 localhost MINIO URL。**缺**:`javascript:` 应被拒、`http://no-protocol` 应被拒、超长字段、空字段

## 27. File: `src/user/pipes/create-user.pipe.ts` (10 lines) — LOW-25 死代码

## 28. File: `src/user/__tests__/user.controller.spec.ts` (68 lines)
- 测了 searchByAccountId、remove 自己、admin 删别人、非 admin 删别人 ✅
- 缺:create、updateUser、updateUserStatus、findOne 各路径

## 29. File: `src/user/__tests__/user.service.spec.ts` (77 lines)
- 只覆盖 findByExactAccountId

## 30. File: `src/user/__tests__/user.update-normalization.spec.ts` (100 lines)
- 覆盖 birthday/profile fields/city,**没覆盖 assertUrlsAreSafe**(有 MINIO 时拒外站 URL 的关键路径)
- 没覆盖 `birthday: null`、`birthday: ''` 两个边界

---

## 31. File: `src/utils/account-id.ts` (11 lines)

### Walkthrough
- `randomBytes(6)` → 6 bytes
- `b % 36` 映射到 `[A-Z0-9]` — **modulo bias**:256 / 36 = 7.111…,余 4,意味着 `[0..3]` 的字符比 `[4..35]` 多出现一次,**字符不等概率**
- 6 个字符 × log2(36) ≈ 31 bits 实际熵(理论 36^6 ≈ 2.2 G)
- 输出 `ACC_XXXXXX`(8-ish chars)

### Findings
- [LOW-27] L7-9: modulo bias
- [LOW] 6 字符在用户量上百万时碰撞概率非零(约 1% @ 5000 用户 — 生日悖论);未在调用方处理 retry

### Verified OK
- 使用 `crypto.randomBytes` 而非 `Math.random()`

---

## 32. 修复建议(只列 HIGH/MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 | `auth.module.ts:21` 改 `expiresIn: configService.get<string>('JWT_EXPIRES_IN') ?? '1h'`;`refresh-token.service.ts:5` 同改 env-driven |
| #2 | `UserService.remove` 与 `updateStatus`:在状态变为 BANNED/DELETED 后 `await this.refreshTokenService.revokeAll(id)`,需要先在 `auth.module` 把 `RefreshTokenService` 加进 `exports` |
| #3 | `AuthService.refresh` L168 后加 `if (user.status !== 'ACTIVE') throw new UnauthorizedException(...)` |
| #4 | `public-user.dto.ts` 删 `username` 字段 |
| #5 | `AuthService.login`:`status !== ACTIVE` 也返回 `'Invalid credentials'` 同消息(不区分);避免账号 enum |
| #6 | `/user/search/account` 加专属 limiter(如 30 req / 15min / userId)+ optional `@Throttle` 装饰;考虑改成请求好友时按 service 内部调用,不暴露通用 search |
| #7 | `RefreshTokenService.rotate`:增加 reuse detection — 当 `findUnique(token)` 返回的记录已被 revoke(即 updateMany 命中 0 但 record 存在过)→ `revokeAll(record.userId)` 并通知 |
| #8 | `RegisterDto` / `getSessionContext` 加 `MaxLength(64)` x-device-name;schema migration 加 `@db.VarChar(64)` |
| #9 | 把 `RefreshTokenService` 加进 `auth.module.ts` exports |
| #10 | `AuthService.me`:DB update 失败时 **不再返回伪造**,直接传出 503 或 fire-and-forget(读完先返回,update 不阻塞、失败 silent log) |
| #11 | `PublicUserDto`:把 wechat/qq/whatsup 挪到 `SelfUserDto` 或加 `friendsOnly` 视图(PM 决策) |
| #12 | `GetUserDto.limit` 加 `@Max(100)` |
| #13 | `/auth/logout` 加 endpoint-level limiter |
| #14 | logoutAll 后,若引入 token blacklist 才能严格生效;现阶段缩短 access token TTL(如 5 min) |
| #15 | OpenIM 重试:增加 backoff + 失败次数计数器,或专门 cron 重试 unsynced 用户 |
| #16 | `RefreshTokenService.rotate` 同时 update 旧 token 的 `lastUsedAt`;或在 access-token 路径里 hook |
| #17 | 补 `rotate happy path` + race 测试 |
| #18 | 把 stale `u.username` 改成 `u.accountId`,并删除前面的 mockImplementation(让 ctor 里的 implementation 唯一) |
| #19 | `CreateUserDto` 加 email/phoneNumber 字段,或 `UserService.create` 不接受这两参数 |

---

## 33. Phase 1 总评

- **Auth 主链**(register/login/refresh/logout/changePassword/me)流程**结构正确**:argon2、随机 refresh token、token hash 入库、TOCTOU 防护、密码改动撤 session — 都做对了
- **薄弱面**主要是:**状态变更不同步**(BAN/DELETE 用户不撤 session,refresh 不重检状态)、**信息暴露 oracle**(login 双消息 + search account 无限流)、**配置漂移**(env 加了不用,值硬编码)
- **User 模块**整体比 Auth 简陋:list 无 max、URL 校验用 startsWith、social handles 公开 visibility、PublicUserDto 残留死字段
- **测试覆盖**侧重 happy path,缺关键 negative case:rotate race、login banned、me 404、change password

下一步:Phase 2a — Friend core(1166 行最大 service,拆两份)。
