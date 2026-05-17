# Phase 8 — OpenIM Integration Review

> 范围:`src/openim/`(`openim.module.ts` / `openim.service.ts`)+ 调用方(auth / circle / circle-invitation)对 OpenIM 的使用方式。
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **MED** | [openim.service.ts:34-62](src/openim/openim.service.ts:34) `getAdminToken` / `fetchAdminToken` | OpenIM 持续不可达时无熔断 / 无 backoff:`adminToken` 失败后保持 `null` → **每一次** register / login / 建圈 / 邀请都重新尝试 fetch admin token,各付一次 5s 超时。与 Phase 1 #15 同根 |
| 2 | **MED** | [openim.service.ts:174-185](src/openim/openim.service.ts:174) `post` | `fetch` 后**不检查 `response.ok`** 直接 `response.json()`。OpenIM / 网关返回非 JSON 的 5xx(HTML 错误页)→ `json()` 抛解析错误,而不是清晰的 "OpenIM HTTP 502" |
| 3 | **MED** | [openim.service.ts:97](src/openim/openim.service.ts:97) `getUserToken` + [auth.service.ts:275](src/auth/auth.service.ts:275) | `platformID` 默认 `2`(Android),`auth.service` 调 `getUserToken(userId)` **从不传真实端**;iOS / Web 客户端拿到的 imToken 绑定在 Android 平台 → OpenIM SDK 登录按多端策略可能失败 / 被踢 |
| 4 | **MED** | [openim.service.ts:159-195](src/openim/openim.service.ts:159) `post` + token 缓存 | admin token 缓存 20h("通常 24h"的猜测)。token 在 20h 内提前失效时,`post` 对任何 `errCode!=0` 一律抛错,**不识别"token 过期"并强制刷新** → 直到 20h 缓存到期前,所有 OpenIM 调用持续失败 |
| 5 | **MED** | `OpenimService` 整体 | 只有 user / token / **group** 方法,**没有任何好友关系方法**(`addFriend` / `removeFriend`)。circle_be 的加好友 / 删好友 / 拉黑**完全不同步到 OpenIM 好友体系** —— 若产品要好友 1:1 聊天,这条链路缺失(需 confirm:是否只用群聊 / 是否允许非好友消息) |
| 6 | LOW | [openim.service.ts:164](src/openim/openim.service.ts:164) `post` | 每次调用 `await import('crypto')` 动态导入 —— 应是顶层 `import { randomUUID }` |
| 7 | LOW | [openim.service.ts:159-195](src/openim/openim.service.ts:159) | 单次尝试,无瞬时失败重试(可接受 —— 调用方有 `openimSynced` 的登录补偿,但值得记) |
| 8 | LOW | `src/openim/` | 无 spec 文件 —— token 缓存逻辑、`enabled` 门控、thundering-herd 防护都没测 |

共 **8 项**:HIGH 0、MED 5、LOW 3。

---

## 1. `openim.module.ts` (8 lines)
标准 module,`exports: [OpenimService]`(auth / circle / circle-invitation 都 inject)。**OK**。

## 2. `openim.service.ts` (196 lines)

### Walkthrough
- L14-22 ctor:读 `OPENIM_API_URL` / `OPENIM_ADMIN_SECRET`;`enabled = Boolean(apiUrl && adminSecret)`
- L24-30 `onModuleInit`:未配置仅 warn(不预取 token,首调懒加载 —— OK)
- L34-49 `getAdminToken`:缓存命中直接返回;否则**共享 in-flight promise**(thundering-herd 防护)✓
- L51-62 `fetchAdminToken`:`post('/auth/get_admin_token')`,缓存 20h
  - 🟠 MED-1:失败不缓存、无 backoff
  - 🟠 MED-4:20h 是猜测,提前失效无自愈
- L70-91 `registerUser`:`enabled` 门控 ✓;admin token + `post('/user/user_register')`
- L97-107 `getUserToken`:`platformID = 2` 默认(MED-3)
- L111-155 `createGroup` / `addGroupMembers` / `removeGroupMember`:group 同步,`enabled` 门控 ✓
- L159-195 `post` HTTP helper:
  - L164 `await import('crypto')` 每次动态导入(LOW-6)
  - L165-169 headers:`operationID: randomUUID()` ✓ trace id
  - L174-179 `fetch` + `AbortSignal.timeout(5000)` ✓ 硬超时
  - L181-185 `response.json()` —— 🟠 **MED-2:不查 `response.ok`**
  - L187-192 `errCode != 0` → log(不含 secret/body)+ 抛错 ✓

### Findings
- [MED-1] L51 admin token 失败无熔断/backoff
- [MED-2] L181 不查 response.ok
- [MED-3] L97 platformID 硬默认
- [MED-4] token 失效无自愈
- [MED-5] 无好友关系同步方法
- [LOW-6] L164 动态 import
- [LOW-7] 无瞬时重试
- [LOW-8] 无 spec

### Verified OK ✅
- 每个方法 `enabled` 门控 —— OpenIM 未配置时干净降级(返回 `''` / `void`)
- thundering-herd 防护(共享 `adminTokenRefreshPromise`)
- 5s 请求硬超时(`AbortSignal.timeout`)
- 每请求唯一 `operationID`
- admin secret 不进日志(只 log `path` + `errMsg`)
- token 缓存避免每调一次取一次
- userID = circle_be `User.id` —— 干净 1:1 映射
- **调用方全部把 OpenIM 当 best-effort**:`auth.service` `.catch` getUserToken、`circle` / `circle-invitation` 的 OpenIM 调用都 `try/catch` + warn —— 一次 OpenIM 失败不会打断业务事务

---

## 3. 调用方使用方式核对

| 调用点 | 方式 | 评价 |
|---|---|---|
| `auth.service.register` / `login` | `registerUser` fire-and-forget `.then/.catch`,`openimSynced` 标记 + 登录重试 | ✓ 非阻塞;但重试无 backoff(Phase 1 #15) |
| `auth.service.issueTokens` | `getUserToken(userId).catch(()=>'')` | ✓ 失败回空串;⚠️ 但 platformID 恒 2(MED-3) |
| `circle.createCircle` | `createGroup` 事务**后**调用,`try/catch` + warn | ✓ 非阻塞 |
| `circle.joinCircle` / `leaveCircle` | `addGroupMembers` / `removeGroupMember`,`try/catch` + warn | ✓ |
| `circle-invitation.respond` / `adminApprove` | `syncApplicantToGroup` 事务后调用,`try/catch` + warn | ✓ |

调用方这一侧"事务外 + 非阻塞 + catch"的模式是对的 —— OpenIM 故障不污染业务数据。

---

## 4. 修复建议(只列 MED)

| ID | 建议补丁 |
|---|---|
| #1 | `getAdminToken` 加轻量熔断:连续失败时短暂记一个 `cooldownUntil`,冷却期内直接抛"OpenIM unavailable"而不再发起 5s 超时请求;或记失败次数 + 指数 backoff |
| #2 | `post` 在 `response.json()` 前先判 `if (!response.ok)`;非 2xx 时读 `response.text()` 截断后抛 `OpenIM HTTP ${status}` |
| #3 | `getUserToken` 的 `platformID` 由调用方传入 —— `auth` 的 login/register 从客户端取 platform(header 或 body),透传;默认值保留作兜底 |
| #4 | `post` 识别 OpenIM 的"token 失效"errCode(如 1501/1503 等鉴权类),命中时清 `adminToken` 并重取一次再重试该请求;或缩短缓存 TTL 并接受偶发失败 |
| #5 | confirm 产品:好友 1:1 聊天是否需要 OpenIM 好友关系。需要则给 `OpenimService` 加 `importFriends`/`removeFriend`,在 friend `handleRequest`(accept)/ `removeFriend` / `blockUser` 里同步(事务后、非阻塞,与 group 同模式) |

---

## 5. Phase 8 总评

- **集成骨架是对的**:`enabled` 门控干净降级、5s 硬超时、thundering-herd 防护、operationID trace、secret 不入日志、userID 1:1 映射 —— 而且**调用方一侧**统一用"事务外 + 非阻塞 + catch",OpenIM 故障不会污染业务数据。这套 best-effort 模式值得肯定
- **薄弱面是"故障韧性与多端正确性"**:
  - OpenIM 持续 down 时,每次业务操作都付 5s 超时、token 反复重取(MED-1)
  - 非 JSON 错误响应处理不当(MED-2)
  - imToken 平台恒为 Android(MED-3)、token 失效无自愈(MED-4)
- **功能缺口**:好友关系完全没同步到 OpenIM(MED-5)—— friend 2a#2 提到的"block 不撤 IM 关系"其实是这个缺口的一部分
- **无 HIGH** —— 无鉴权问题、无 secret 泄露、无金钱;MED 集中在韧性、多端、功能完整性

下一步:Phase 9 — Cross-cutting(跨模块收尾)。
