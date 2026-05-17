# Phase 0 — Infra & Cross-cutting Review

> 范围:bootstrap (`main.ts` / `setup.ts` / `app.module.ts`)、`config/`、`filters/`、`interceptors/`、`guards/`、`decorators/`、`enum/`、`prisma/`、tsconfig、Dockerfile、env 文件、.gitignore
> 颗粒度:逐文件逐行
> 验证手段:`npx tsc --noEmit`(已运行)、`git ls-files`(已运行)

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **CRITICAL** | `.env.development:8`, `.env.test:6`, `.env.production:11` | 全部 `.env*` 提交进 git;`SECRET` 明文写死,`MINIO` / DB 凭证泄露 |
| 2 | **HIGH(build break)** | `src/app.module.ts:6,33` | `LogsModule` 路径 `./logs/logs.module` 不存在,`tsc` 报 TS2307 |
| 3 | **HIGH** | `src/setup.ts:100-106` | 全局 `ValidationPipe` 没开 `forbidNonWhitelisted` — mass assignment 风险 |
| 4 | **HIGH** | `src/filters/all-exception.filter.ts:38-49` | 异常响应**回显请求 headers / body / query** 给客户端 — token / 密码原样返回 |
| 5 | **HIGH** | `src/filters/all-exception.filter.ts:51` | `logger.error('[toimc]', { headers, body, ... })` 把整个请求体进 log — token、密码、PII 泄漏 |
| 6 | **HIGH** | `tsconfig.json:14-18` | `strictNullChecks:false` + `noImplicitAny:false` — 全项目类型安全降级 |
| 7 | **HIGH** | `src/main.ts:34-42` | 非 production 下 CORS=`true`,允许任意 origin + credentials,本地开发环境 token 可被任意页面读取 |
| 8 | **MEDIUM** | `src/filters/prisma-exception.filter.ts:32` | default 把所有未识别 Prisma 错误归 500 "Database error" 但不打日志,无法事后追查 |
| 9 | **MEDIUM** | `src/setup.ts:155-163` | `/api/v1/friend/:id/report` rate limit 用正则匹配,但 `friendRequestLimiter` 已经先于它在 `/api/v1/friend/requests` 注册,语义勉强 ok;改派应用层 |
| 10 | **MEDIUM** | `Dockerfile:2`, `Dockerfile.prod:2,18` | Node 14 已 EOL(2023-04),且 `Dockerfile.prod` 把 dist 拷到 `/usr/share/nginx/html` 完全不对 |
| 11 | **MEDIUM** | `package-lock.json` 与 `pnpm-lock.yaml` 并存 | 锁文件冲突,不同人安装会得到不同依赖树 |
| 12 | **MEDIUM** | `src/setup.ts:87` | `flag && app.useLogger(...)` 当 LOG_ON=false 时不替换 logger,但 winston provider 仍被 inject(若 winston 模块未引入则 `app.get(WINSTON_MODULE_NEST_PROVIDER)` 抛错) |
| 13 | **MEDIUM** | `src/config/env.validation.ts` | 缺 `SECRET` 长度 / 复杂度校验(只 required);缺 `JWT_EXPIRES_IN` / `REFRESH_EXPIRES_IN`;缺 `ALLOWED_ORIGINS` 在测试环境之外的强校验 |
| 14 | **MEDIUM** | `src/guards/casl.guard.ts:36-61` | `req.user.role` 取的是单个 role,无 user 时返回 false(ok),但 `forRoot` 失败时无 try/catch,异常会 500 而非 403 |
| 15 | **MEDIUM** | `src/interceptors/response.interceptor.ts:27` | 统一返回 `code: 0` ok,但 4xx/5xx 由 `PrismaExceptionFilter`/Nest 默认 filter 输出**不同**结构 `{ code: status, message }`,前端要解两套 |
| 16 | LOW | `src/main.ts:50-60` | Swagger 路径 `/docs` 在生产环境无访问控制 |
| 17 | LOW | `src/setup.ts:86-87` | `// app.useLogger(...)` 注释代码 + 等价代码并存 |
| 18 | LOW | `src/setup.ts:93-97`、`108-111` | 大段被注释的旧代码 |
| 19 | LOW | `src/filters/http-exception.filter.ts` | 文件存在但未注册,死代码;同时遗留 `// throw new Error('Method not implemented.')` |
| 20 | LOW | `src/decorators/casl.decorator.ts:18` | typo:`CheckPolices` 应 `CheckPolicies` |
| 21 | LOW | `src/guards/jwt.guard.ts` | 空 constructor 多余 |
| 22 | LOW | `src/filters/all-exception.filter.ts:47` | typo `exceptioin` |
| 23 | LOW | `src/prisma/prisma.service.ts:31` | `allowsStartWithoutDatabase(process.env)` 在测试环境仍可能误触发,缺 NODE_ENV !== production 守门 |
| 24 | LOW | `src/enum/config.enum.ts` | 与 `env.validation.ts` 重复定义键名,易漂移 |

---

## 1. File: `src/main.ts` (69 lines)

### Walkthrough
- **L1–4** 旧 toimc 版权头(MIT);保留即可
- **L5** `import 'module-alias/register';` — 启动期注册 `_moduleAliases`(`package.json` 里定义 `src: "src/"`)。**风险**:Nest 项目本身用 `tsconfig.paths` 已覆盖,运行时 `node dist/...` 又靠 `_moduleAliases.src = "src/"` 指到 dist 上层,容易和 `nest build` 输出路径错位
- **L13–28 `resolveAppPort`** — 接受 number 或纯数字字符串,范围 0–65535,否则抛。**OK**(单测有覆盖 `main.spec.ts`)
- **L30** `bootstrap()` 缺 try/catch,任何 init 失败直接 unhandled
- **L31** `getServerConfig()` 自己解析 .env,这与 L19 `ConfigModule.forRoot({ validationSchema })` 路径分离 → 同一份 env 有两个解析源,易漂移
- **L33–38** CORS allowed origins:`process.env.ALLOWED_ORIGINS?.split(',')` 不做空字符串过滤,`"https://a.com,,https://b.com"` 会得到 `["https://a.com", "", "https://b.com"]`
- **L40–42** `isProduction ? {origin, credentials:true} : true`
  - 🔴 **HIGH(#7)**:dev 下 `cors: true` 让任意 origin + credentials 反射 → 本地启动时浏览器扩展 / 任意页面可以代用户 fetch
  - 修复:dev 也用白名单(localhost:* + LAN IP)
- **L49–60** Swagger 一直注册,无生产开关
  - 🟡 **LOW(#16)**:生产应基于 `NODE_ENV !== 'production'` 才挂 `/docs`,或加 basic-auth
- **L62** `resolveAppPort(config['APP_PORT'] ?? 3000)` — `config` 由 `getServerConfig()` 解析,**绕过 joi 校验**(`createEnvValidationSchema` 在 ConfigModule 里跑过,但这里又直接读了一次)
- **L66–68** `if (require.main === module) bootstrap();` — ok,允许测试 import 该文件不触发监听

### Findings in this file
- [HIGH-7] L40–42:dev CORS 太宽
- [MED] L31 + L62:env 两套解析源
- [MED] L33–38:`split(',')` 不 trim 空段
- [LOW] L30:bootstrap 无 try/catch
- [LOW-16] L56:`/docs` 无环境/auth 门控

### Verified OK
- 端口校验集中在 `resolveAppPort`,单测覆盖到坏字符串
- Swagger 启用 `persistAuthorization` 仅影响 UI 行为
- 未在 main 里直接 logger.log token

---

## 2. File: `src/main.spec.ts` (12 lines)

### Walkthrough
- 仅 2 个 `resolveAppPort` 单测:坏字符串、数字字符串
- **缺**:边界 0 / 65535、超过 65535 的数字、`-1`、float、`null`、空字符串

### Findings
- [LOW] 测试覆盖不全 — 应补 4 个 edge case

---

## 3. File: `src/setup.ts` (165 lines)

### Walkthrough
- **L1–9** imports ok
- **L11–80** 7 个独立 rateLimit 配置(auth / refresh / friend / coin / note / friend report / circle / trace)
  - 配置粒度 ok,但**全部在文件顶层即时创建**,被 import 时就执行 → 单测 import 时也会创建,无副作用但浪费
- **L82** `setupApp(app: INestApplication)`
- **L83** `getServerConfig()` 又一次读 .env(第三处)
- **L85–87** `flag && app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER))`
  - 🔴 **MED(#12)**:`nest-winston` 在 dependencies,但项目里**没有 import `WinstonModule.forRoot(...)` 注册 provider**(应当在 `LogsModule` 里 — 但 LogsModule 不存在!),`app.get(WINSTON_MODULE_NEST_PROVIDER)` 在 `LOG_ON=true` 时会抛 `Nest can't resolve dependencies` → 启动失败
  - 当前没炸是因为 LogsModule 这一行也是断的(下面 #2)
- **L88** `app.setGlobalPrefix('api/v1')` ok
- **L90** `app.useGlobalFilters(new PrismaExceptionFilter())` — **只注册 Prisma**,没有 fallback;`AllExceptionFilter` 在 L97 被注释掉了
  - 🔴 **HIGH 间接**:非 Prisma、非 HttpException 的错误会进 Nest 默认 filter,生产环境会输出栈
- **L91** `app.useGlobalInterceptors(new ResponseInterceptor())` ok
- **L93–97** 注释代码块,删除
- **L100–106** 全局 ValidationPipe:
  ```ts
  new ValidationPipe({
    whitelist: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  })
  ```
  - 🔴 **HIGH(#3)**:**缺 `forbidNonWhitelisted: true`** — 未声明字段被静默丢弃而不是 4xx,客户端送 `{ ..., role: 'ADMIN' }` 无报错,容易让 reviewer 误以为 DTO 安全
  - 缺 `disableErrorMessages: process.env.NODE_ENV === 'production'` — 生产环境会把字段名 / 约束细节回显
  - `enableImplicitConversion: true` 配合宽松 DTO 可能把字符串自动转 number,要逐 DTO 复核 type-coercion 副作用
- **L108–111** 注释代码,删
- **L114** `app.use(helmet())` ok,但未配置 CSP / HSTS 自定义
- **L117–122** 全局 fallback rate limit 300/min,ok
- **L125–127** auth 路由 10/15min — 偏严但 ok
- **L128** refresh 60/15min — ok
- **L129** `/api/v1/friend/requests` 30/15min
- **L130** `/api/v1/coin/gift` 20/15min
- **L131** `/api/v1/note` 60/15min(覆盖所有 method)
- **L132–149** `/api/v1/circle`、`/api/v1/circle-invitation`、`/api/v1/circle-plaza` 都用 inline middleware 按 method 过滤
  - 🟡 **MED**:写 3 份重复 middleware,可抽 `methodLimiter(limiter, methods)`
  - `req: any, res: any, next: any` — 用 `RequestHandler` 类型替代
- **L150–155** trace 同上
- **L156–163** friend `/:id/report` 用正则 `/^\/[^/]+\/report$/` 匹配 — ok,但只对 POST;
  - **BUG 风险**:此中间件挂在 `/api/v1/friend` 前缀,会先于 `friendRequestLimiter` 在 `/api/v1/friend/requests` 路径上执行 → 同一请求过两道 limiter,quota 双重消耗
  - 这是 [MED-#9]

### Findings
- [HIGH-3] L100–106:ValidationPipe 缺 `forbidNonWhitelisted` / `disableErrorMessages`
- [HIGH 间接] L90:无 AllExceptionFilter fallback
- [MED-12] L87:`WINSTON_MODULE_NEST_PROVIDER` 未注册 provider
- [MED-9] L158:friend limiter 链与上游 `/friend/requests` limiter 同时命中
- [MED] L83:`getServerConfig()` 与 `app.module` ConfigModule 解析路径不一致
- [MED] L131:`/api/v1/note` 限速覆盖 GET 列表,浏览频率受影响
- [LOW] L93–97 / L108–111:大段注释代码
- [LOW] L114:helmet 默认配置足够,但生产建议 explicit CSP

### Verified OK
- 全局 fallback rate limit 存在(300/min)
- 各敏感 endpoint 有独立 limiter
- helmet 启用
- API 前缀 `api/v1`

---

## 4. File: `src/setup.spec.ts` (52 lines)

### Walkthrough
- Mock `getServerConfig` 返回 `{ LOG_ON: 'false' }`
- 测试 1:验证 `useGlobalInterceptors` 调到 `ResponseInterceptor`
- 测试 2:验证 `/api/v1/friend/requests` 与 `/api/v1/coin/gift` 都被注册

### Findings
- [LOW] 仅 2 case;**没测**:
  - 全局 ValidationPipe 注册了
  - PrismaExceptionFilter 注册了
  - helmet 注册了
  - 全局 fallback rate limit 注册了
  - `LOG_ON=true` 路径下的 `useLogger`
- [LOW] mock 用 `as any`,接口失真后测试不会失败

---

## 5. File: `src/app.module.ts` (51 lines)

### Walkthrough
- **L1–19** imports
- **L6** `import { LogsModule } from './logs/logs.module';` — 🔴 **HIGH(#2)** **路径不存在**,`tsc` 报 `Cannot find module './logs/logs.module'`
  - 影响:整个项目无法 `nest build`,无法 `start:prod`
  - 当前 dev/test 跑得起来?**实际是跑不起来**,见下方 §15 验证
- **L21** `const envFilePath = .env.${process.env.NODE_ENV || 'development'}`
- **L25–30** `ConfigModule.forRoot`:
  - `isGlobal: true` ok
  - `envFilePath` 单一 → dev 时 `.env.development`,但 production 时 `.env.production` 里**没有 `DATABASE_URL`**(用了 `DB_HOST` 等旧字段)→ joi 校验**会失败**(joi 要求 DATABASE_URL,除非 ALLOW_START_WITHOUT_DB=true)
  - `load: [() => dotenv.config({ path: '.env', quiet: true })]` — 用 `.env` 做基底,但 dotenv 在 ConfigModule 解析顺序里靠后,可能覆盖关系不直观
- **L31–44** 模块 import 列表
  - `LogsModule` 行 33 一同 broken
- **L46** `controllers: []` ok
- **L47–48** `providers: [Logger], exports: [Logger]` — 全局注入一个 Logger 实例可以,但和 module 自己 `new Logger(name)` 实例混用

### Findings
- [HIGH-2] L6, L33:LogsModule 不存在 → build break
- [HIGH 配置] L21–30 + `.env.production`:production env 字段名错(见 §14 .env)
- [LOW] L28:`load` 用法可改为依赖 ConfigModule 自带的 multi-envFilePath

### Verified OK
- 所有业务模块都被显式注册(没有循环依赖明显信号)
- PrismaModule 排在最前(Global)

---

## 6. File: `src/test.spec.ts` (6 lines)

死代码 hello-world,可删。LOW。

## 7. File: `src/swagger.spec.ts` (17 lines)

只测 DocumentBuilder.metadata,没测 `SwaggerModule.setup` 行为。LOW,可保留作 smoke。

## 8. File: `src/package.spec.ts` (13 lines)

测 `package.json.scripts.postinstall` 含 `prisma generate`。可保留。

---

## 9. File: `src/config/env.validation.ts` (56 lines)

### Walkthrough
- **L1–5** 中文注释 + Joi import
- **L7–9** `readBooleanEnvFlag` — `"true"` → true,其他都 false(包括 `True`、`TRUE`、`1`)
  - 已 `.toLowerCase()`,**接受 "TRUE" / "True"**,**不接受 "1" / "yes"**
- **L11–15** `allowsStartWithoutDatabase`
- **L17–21** `shouldSkipPrismaConnectOnBoot`
- **L23–55** `createEnvValidationSchema`
  - **L26–28** DATABASE_URL 条件 required
  - **L31** NODE_ENV 三值,default development
  - **L34** DATABASE_URL ok
  - **L35** SECRET required — **缺 `.min(32)`**;dev 文件里是 64 字符,但生产没有强制
  - **L36** LOG_ON boolean(joi 会接受 "true"/"false")
  - **L38** APP_PORT number — 缺 `.port()` 或 `.min(0).max(65535)`(在 `resolveAppPort` 里二次校验,但 joi 层应该兜底)
  - **L41–47** OpenIM / MINIO 全部 optional — 但项目里 upload 模块依赖 MINIO,没设值时启动不会报但调用会 500
  - **L49–53** ALLOWED_ORIGINS 在 production required(✅ 良好);非 production optional
- **缺校验项**:`JWT_EXPIRES_IN` / `REFRESH_EXPIRES_IN` / `BCRYPT_ROUNDS` / `MINIO_REGION` 等

### Findings
- [MED-13] L35:SECRET 无长度校验
- [MED] L38:APP_PORT 无范围
- [MED] L43–47:upload 必需的 MINIO_* 全 optional,违反 fail-fast
- [MED] 缺 token 过期时间等关键 env
- [LOW] L7–9:布尔解析不接受 "1"/"yes"

### Verified OK
- NODE_ENV 枚举校验
- production 要求 ALLOWED_ORIGINS
- DATABASE_URL 在常规启动下 required
- 单测覆盖了 ALLOW_START_WITHOUT_DB 分支

---

## 10. File: `src/config/env.validation.spec.ts` (29 lines)

### Walkthrough
- 测 1:default 下 DATABASE_URL required(✅)
- 测 2:degraded startup 下允许缺 DATABASE_URL(✅)

### Findings
- [LOW] 缺 SECRET 缺失测试、缺 NODE_ENV=production 时 ALLOWED_ORIGINS 缺失应失败的测试

---

## 11. File: `src/config/server.config.ts` (16 lines)

### Walkthrough
- **L1–2** imports
- **L4–9** `getEnv(path)`:存在则 `dotenv.parse` 返回 dict,否则 `{}`
- **L11–15** `getServerConfig()`:base = `.env`,specific = `.env.${NODE_ENV}`,后者覆盖

### Findings
- [MED] 与 `ConfigModule` 解析逻辑**冗余且不一致**:ConfigModule 用 `envFilePath` 单文件 + `load`,这里用 base + specific 合并;同一个 KEY 在两边可能不同优先级
- [LOW] 文件**同步**读 fs,模块 import 时若用作 module-level eager call 会卡 boot;实际是函数,调用时才读,ok

---

## 12. File: `src/filters/all-exception.filter.ts` (55 lines)  ⚠️ 当前未注册

### Walkthrough
- **L12** `@Catch()` 无参 → catch-all
- **L14–17** ctor 收 Logger + HttpAdapterHost
- **L18–22** 取 request / response
- **L24–27** 状态码:HttpException 取 getStatus,否则 500
- **L29** `const msg: unknown = exception['response'] || 'Internal Server Error';`
  - 用方括号取属性绕过类型,如果 exception 非对象会 throw `Cannot read property` → filter 本身崩
- **L31–36** 注释代码
- **L38–49** responseBody:
  ```js
  { headers: request.headers,
    query: request.query,
    body: request.body,
    params: request.params,
    timestamp,
    ip,
    exceptioin: exception['name'],   // ← typo
    error: msg }
  ```
  - 🔴 **HIGH-4(若启用)**:把 `request.headers`(含 Authorization!)、`request.body`(含 password / refreshToken)原样**返回给客户端**;任何错误回包都是一封"自助 dump"
- **L51** `this.logger.error('[toimc]', responseBody);` — 同样把整个 body 写日志
  - 🔴 **HIGH-5(若启用)**:winston 文件 / stdout 落到日志服务,token / 密码全保留
- **L52** `httpAdapter.reply(response, responseBody, httpStatus);`

### Findings
- [HIGH-4] L38–49:dump request 到响应体
- [HIGH-5] L51:dump 到日志
- [MED] L29:`exception['response']` 不安全访问
- [LOW] L47:typo `exceptioin`
- [LOW] L31–36:注释代码

### Verified OK
- catch-all 状态码兜底
- 注入 HttpAdapterHost(为多平台兼容)

> 当前 `setup.ts:97` 把它**注释掉了**,所以这些 HIGH 暂未发生 — 但意图是"以后启用"。Phase 0 建议:**重写整个 filter**(用 Pattern E 的脱敏版本)再启用,不要原样恢复。

---

## 13. File: `src/filters/http-exception.filter.ts` (30 lines)  ⚠️ 死代码

### Walkthrough
- `@Catch(HttpException)` 单类型 catch
- **L19** `logger.error(exception.message, exception.stack)`
- **L20–26** 响应 `{ code: status, timestamp, message }`
- **L27** 留了一条 `// throw new Error('Method not implemented.')` — 注释噪音

### Findings
- [LOW-19] 整个文件未在 setup 注册,死代码
- [LOW] L27:残留 placeholder

---

## 14. File: `src/filters/prisma-exception.filter.ts` (38 lines)  ✅ 已注册

### Walkthrough
- **L7** `import { Prisma } from 'src/generated/prisma';` — 依赖 `prisma generate` 输出;`src/generated` 在 `.gitignore` 中,首次 clone 后必须先 `pnpm install`(postinstall) 才有
- **L9** `@Catch(Prisma.PrismaClientKnownRequestError)` — 只 catch known request,**unknown / panic / validation 不接管**
- **L11–17** 取 ctx / response
- **L18–33** switch:
  - P2002 → 409 "Resource already exists"
  - P2025 → 404 "Resource not found"
  - P2003 → 400 "Invalid reference"
  - default → 500 "Database error"(**保持 500**,无日志)
- **L35** `response.status(status).json({ code: status, message })`

### Findings
- [MED-8] L31–32:default 分支 silent fallback,500 客户端只见 "Database error",运维端无线索;应 `console.error` / logger.error
- [MED] P2002 没回传冲突字段(`exception.meta?.target`),前端无法定位重复字段
- [MED] 没处理 Prisma 其他错误类型:`PrismaClientValidationError`、`PrismaClientUnknownRequestError`、`PrismaClientInitializationError`(数据库挂了)
- [MED] 响应 schema `{ code, message }` ≠ ResponseInterceptor 的 `{ code:0, message:'ok', data }` → 前端必须双解析
- [LOW] 缺 requestId、缺 timestamp

### Verified OK
- 三个最常见 Prisma 错误码已处理
- 状态码语义正确(409/404/400)

---

## 15. File: `src/interceptors/response.interceptor.ts` (30 lines)  ✅ 已注册

### Walkthrough
- **L10–14** `ApiResponse<T>` shape
- **L17–20** 泛型 class,T → ApiResponse<T>
- **L26–27** `map((data) => ({ code: 0, message: 'ok', data: data ?? null }))`

### Findings
- [MED-15] 与 PrismaExceptionFilter 出参 schema 不一致(`code:0` vs `code:status`)
- [LOW] 没记 traceId / 不附 timestamp
- [LOW] 空 ctor 参数 `_context` 命名只为忽略 lint,可接受

### Verified OK
- 类型签名 `<T, ApiResponse<T>>` 完整
- 不修改原 stream,只 map

---

## 16. File: `src/interceptors/serialize.interceptor.ts` (29 lines)  ⚠️ 未注册到全局

### Walkthrough
- 通用 dto 序列化拦截器
- **L12** ctor `(private dto: any)` — 接受 class
- **L17–25** `plainToInstance(this.dto, data, { excludeExtraneousValues: true })`
- 主要靠 `@Serialize(Dto)` 装饰器使用(decorators/serialize.decorator.ts)

### Findings
- [LOW] ctor 用 `any`,可改 `ClassConstructor`
- [LOW] 注释代码两行

### Verified OK
- `excludeExtraneousValues: true` 是正确选项,强制每字段显式 `@Expose`

---

## 17. File: `src/guards/jwt.guard.ts` (12 lines)

仅 `extends AuthGuard('jwt')`,带空 ctor 与一行注释。

### Findings
- [LOW-21] ctor 多余,删除
- [LOW] 注释 `// @JwtGuard()` 无意义

### Verified OK
- 继承 Passport JWT 实现

---

## 18. File: `src/guards/admin.guard.ts` (11 lines)

`request.user?.role === Role.Admin`。

### Findings
- 无问题,但**前提**是 chain 上必须先有 `JwtGuard`,否则 `request.user` 永远 undefined → 安全行为是 deny,ok
- [LOW] 未支持多角色(`isAdmin` flag);后期若 role 体系扩展需重构

### Verified OK
- 默认 deny(`req.user?.role` undefined → false)

---

## 19. File: `src/guards/role.guard.ts` (23 lines)

`Reflector.getAllAndOverride<Role[]>` → `roles.includes(req.user?.role)`。

### Findings
- [LOW] 缺 metadata 时 return true(L15–17) — 这是 *合理* 默认,只是要求所有路由必须显式 `@Roles(...)` 才有意义;若 controller 想 require 登录但不 require role,本 guard 形同虚设,需依赖 JwtGuard
- 没问题

---

## 20. File: `src/guards/casl.guard.ts` (64 lines)

### Walkthrough
- **L19–30** 取 3 类 metadata:HANDLER / CAN / CANNOT
- **L32–34** 全部为空 → return true(放行)
  - **MED**:此默认与 `RoleGuard` 一致;若 CaslGuard 被全局加但 controller 没声明任何 policy,等同于 noop
- **L35** 取 request
- **L36** `if (req.user)`
- **L38** `await this.caslAbilityService.forRoot(req.user.role)` — 无 try/catch
  - 🟡 **MED-14**:`forRoot` 若抛(如 role 未在 ability 注册),整个 request 500;应该 catch → 403
- **L40–57** 三段 flag 折叠:handlers → can → cannot
  - `handlers.every((h) => h(ability))` 期望 handler **同步返回 boolean** — 与 `PolicyHandlerCallback = (ability) => boolean` 一致 ok
- **L59–61** 无 user → return false ok

### Findings
- [MED-14] L38:无 try/catch
- [LOW] 重复的 `instanceof Array` / `typeof === 'function'` 分支可抽

### Verified OK
- 无 user 默认 deny
- 三类策略合取(can ∧ ¬cannot)

---

## 21. File: `src/guards/__tests__/admin.guard.spec.ts` (25 lines)
- ✅ 覆盖了 user 不存在、role=USER、role=ADMIN
- 完整

## 22. File: `src/guards/__tests__/role.guard.spec.ts` (41 lines)
- ✅ deny 与 allow 各一
- 缺:metadata 为空时放行测试

## 23. File: `src/guards/__tests__/casl.guard.spec.ts` (59 lines)
- ✅ HANDLER + CAN 都有,验证 false
- 缺:没有 metadata 时直接放行、`req.user` 不存在时 deny、`forRoot` 抛错时行为

---

## 24. File: `src/decorators/casl.decorator.ts` (40 lines)
- [LOW-20] L18:typo `CheckPolices` → `CheckPolicies`(已经被 import 多处,改名要全局替换)

## 25. File: `src/decorators/roles.decorator.ts` (7 lines)
- OK

## 26. File: `src/decorators/serialize.decorator.ts` (11 lines)
- OK,interface 本地定义可挪到 types

## 27. File: `src/enum/{action,config,roles}.enum.ts`
- 都是简单 enum
- [LOW-24] `config.enum.ts` 与 `env.validation.ts` 重复定义 env key 名,易漂移

---

## 28. File: `src/prisma/prisma.module.ts` (10 lines)
- `@Global()` + providers/exports PrismaService
- ✅ ok

## 29. File: `src/prisma/prisma.service.ts` (121 lines)

### Walkthrough
- **L7** `import { PrismaPg } from '@prisma/adapter-pg'` — Prisma 7 + adapter
- **L8** `import { PrismaClient } from 'src/generated/prisma'` — 依赖 generate
- **L20** `private readonly logger = new Logger(PrismaService.name)` ok
- **L25–49** ctor:
  - L27–30 connectionString 来源 `process.env.DATABASE_URL` ?? `config['DATABASE_URL']` ?? `''`
  - L31 `allowsStartWithoutDatabase(process.env)`
  - L33–37 缺 url 且不允许 degraded → throw
  - L39–45 super:有 url 用 adapter,否则 `{}` (会 fallback datasource block from schema)
- **L51–76** onModuleInit
  - L52 `shouldSkipConnectionOnBoot` 内含 url 空 → skip
  - L58–62 try connect → set isConnected
  - L63–75 catch:degraded 时记 error 但不 throw;否则 throw
- **L78–81** onModuleDestroy disconnect
- **L83–85** isDatabaseConnected getter
- **L87–111** connectIfNeeded 重连
- **L113–119** shouldSkipConnectionOnBoot

### Findings
- [MED] L33:仅在**完全无 url 且非 degraded** 时 throw;url 字符串非法不会拦
- [LOW-23] L31 `allowsStartWithoutDatabase` 在 prod 也接受 — 应限制 `NODE_ENV !== 'production'` 才允许 degraded
- [LOW] L67–69:error message 拼接里没标 `[Prisma]` 前缀
- [LOW] connectIfNeeded 没有 mutex,并发调用可能多次 `$connect`

### Verified OK
- DI 接口完整(OnModuleInit/Destroy)
- adapter-pg 正确接入
- 单测覆盖 4 路径

---

## 30. File: `src/prisma/prisma.service.spec.ts` (102 lines)
- ✅ throw、degraded、skip-on-boot、connect 成功 都有
- 缺:connect 失败 + 非 degraded 应 rethrow 的路径、connectIfNeeded 成功/失败

---

## 31. tsconfig.json + nest-cli.json

### Findings
- [HIGH-6] `tsconfig.json`:
  ```json
  "strictNullChecks": false,
  "noImplicitAny": false,
  "strictBindCallApply": false,
  "forceConsistentCasingInFileNames": false
  ```
  4 个核心 strict 开关全关 → 业务代码大量 `prisma.user.update(...)` 实际 `user` 不存在(`tsc` 一片飘红)、null 安全丢失
- [LOW] `ignoreDeprecations: "6.0"` — 临时绕过,需要计划清理

---

## 32. .env / .gitignore

### Findings — 🔴 CRITICAL #1
- `git ls-files` 显示 `.env`、`.env.development`、`.env.production`、`.env.test` 全部 **tracked**
- `.gitignore` 不含 `.env*`(只有 `logs/` 等)
- 暴露物:
  - `.env.development:8` JWT SECRET 明文(64 字符,真随机串)
  - `.env.test:6` 同一 SECRET — 任何拿到测试机 JWT 的人 = 拿到生产前的开发机所有用户身份
  - `.env.production:11` SECRET 看起来是另一串,但 base 是 dev 那一串 + 文本 "longrandom",高度怀疑这是占位测试值;无论如何**不该提交**
  - `.env.development` 含 MINIO 凭证(`minioadmin/minioadmin123`)
  - `.env.production` 含 DB user/password(`toimc / mch2lvy2o9vdo32md7bbs6kd2e7ctdcy`)
- 紧急操作建议:
  1. `.gitignore` 加 `.env*` `!.env.example`
  2. `git rm --cached .env .env.development .env.production .env.test` 并提交
  3. **旋转**所有 SECRET / DB password / MINIO key
  4. 若历史 push 过公网仓库,执行 `git filter-repo` 清史 + force-push(谨慎)

`.env.production` 二次问题(MED):
- 字段名为 `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD`,但 `env.validation.ts` 与 `prisma.config.ts` 只读 `DATABASE_URL` → production 部署会 joi 校验失败或 Prisma 无 url
- 缺 `ALLOWED_ORIGINS`,production joi 强制 required → 启动失败
- 文件末缺换行符
- `SECRET` 包含明显占位文本 "longrandom"

---

## 33. Dockerfile / Dockerfile.prod / docker-compose.yml

### Findings
- [MED-10] **Node 14 已 EOL(2023-04-30)**,Nest 11 + Prisma 7 实际需要 Node 18+
- [MED-10] `Dockerfile.prod:18` `COPY --from=build-stage /app/dist /usr/share/nginx/html` — 这是把 Nest 后端的 dist 拷进 nginx 的静态目录,完全不对,production-stage 还在跑 `npm run start:prod`
- [MED] `Dockerfile.prod:14,24` 用淘宝 npm mirror — CN 适合但 prod 应改成稳定 registry
- [LOW] `Dockerfile.prod` 用 `yarn install` 但项目用 pnpm
- [LOW] `Dockerfile`(开发):copy `.` 不做 multi-stage,镜像巨大

---

## 34. 锁文件

- [MED-11] 同时存在 `package-lock.json` 与 `pnpm-lock.yaml`,大小都是 ~500KB / ~300KB
- 不同同事运行 `npm i` vs `pnpm i` 会得到不同依赖
- 项目应**二选一**(README 已写 pnpm → 删 `package-lock.json`)

---

## 35. 构建验证(已执行)

```
$ npx tsc --noEmit
src/app.module.ts(6,28): error TS2307: Cannot find module './logs/logs.module'
src/auth/auth.service.ts(77,40): error TS2339: Property 'user' does not exist on type 'PrismaService'
...(继续 50+ 处相同错误,因为 src/generated/ 没生成)
src/circle-invitation/circle-invitation.service.ts(9,24): error TS2307: Cannot find module 'src/generated/prisma'
src/circle-invitation/circle-invitation.service.ts(628,13): error TS2339: Property 'code' does not exist on type 'unknown'
```

观察:
1. **必须先 `pnpm install`**(触发 postinstall `prisma generate`)再 `tsc`,但生成后 LogsModule 依然 broken
2. `error TS2339 ... 'code' does not exist on type 'unknown'` 在 Phase 5 详查 — 是 catch 块对 `unknown` 类型未 narrow,strict 开关一开就报

---

## 36. 推荐修复(只列 HIGH/CRITICAL,完整放 99-summary)

| ID | 修复 |
|---|---|
| #1 | `.gitignore` 加 `.env*`、git rm cached、轮换所有 SECRET |
| #2 | 删除 `LogsModule` import 或恢复缺失的 `src/logs/logs.module.ts`(若 winston 接线在那里,需要补出完整模块) |
| #3 | `setup.ts:100` 加 `forbidNonWhitelisted: true, disableErrorMessages: production` |
| #4 #5 | 重写 `all-exception.filter.ts` 用 Pattern E(去除 headers / body 回显与日志,加 `requestId` + scrub) |
| #6 | `tsconfig.json` 开启 `strictNullChecks`、`noImplicitAny`(分阶段开,先 strictNullChecks) |
| #7 | `main.ts` dev CORS 改白名单 |

---

## 37. Phase 0 总评

- **架构骨架可用**:模块划分清晰,Guards 三件套到位,Prisma 通过 Global Module 注入,ValidationPipe / helmet / rate-limit 都装了
- **但 production-ready 的 5 个边界缺 3 个**:
  - Pattern A(strict DTO + 全局 ValidationPipe) — 缺 `forbidNonWhitelisted`
  - Pattern B(server-derived identity) — Phase 1 详查
  - Pattern C(transaction wrap) — Phase 3/5 详查
  - Pattern D(throttle + idempotency) — throttle 有,**idempotency 完全没有**
  - Pattern E(scrubbed exception filter) — **没启用,且现有实现回显 token**
- **CRITICAL #1 必须立即处理**,否则后续 review 无意义

下一步:Phase 1 — Auth & User。
