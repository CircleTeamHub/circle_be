# OpenIM 集成说明

## 一、为什么接入 OpenIM

circle_be 是业务后端，负责用户注册/登录、帖子、好友关系、Squad 等业务逻辑。
如果要自己实现即时通讯（IM），需要：WebSocket 长连接管理、消息持久化、在线状态、已读回执、群聊……工作量巨大。

**OpenIM 是一个开源的 IM 服务器**，把上面所有 IM 基础设施打包好了。
我们的策略是：**聊天功能全部交给 OpenIM，circle_be 只做业务层**。

---

## 二、数据库改动 — 删了什么，为什么

### 删除的模型

| 模型 | 原因 |
|------|------|
| `Message` | OpenIM 用 MongoDB 存所有消息，PostgreSQL 不需要再存一份 |
| `MessageDeleteLog` | OpenIM 自己管理消息删除状态 |
| `MessageSticker` | OpenIM 支持自定义消息类型（可用于 emoji 反应） |
| `MessageType` enum | 随 Message 模型一起删除 |

### 保留的模型

| 模型 | 原因 |
|------|------|
| `Friend` | 业务社交层（谁关注谁）；OpenIM 的好友仅控制"能否发消息"，是两个概念 |
| `Squad` + `SquadMember` | 存 Squad 的业务元数据（名称、描述、规则等）；创建 Squad 时会同步给 OpenIM Group |
| `Notification` | 业务通知（点赞/评论/被@）；IM 消息通知由 OpenIM 自己推送 |

---

## 三、新增代码 — 改了什么，为什么

### 3.1 `src/openim/openim.service.ts` — 核心服务

封装了所有对 OpenIM Admin REST API 的调用。

**关键设计决策：**

**1. `enabled` 标志 — 优雅降级**
```typescript
this.enabled = Boolean(this.apiUrl && this.adminSecret);
// 如果没配置 OPENIM_API_URL / OPENIM_ADMIN_SECRET，所有方法直接 return，不报错
```
意义：本地开发不想启动 OpenIM docker 时，后端仍然可以正常启动，只是 imToken 返回空字符串。

**2. Admin Token 缓存 20 小时**
```typescript
if (this.adminToken && Date.now() < this.adminTokenExpiresAt) {
  return this.adminToken; // 命中缓存，不重新请求
}
// OpenIM token 有效期约 24h，我们缓存 20h 留余量
```
意义：每次登录都要拿 imToken，如果每次都去换 admin token 会多一次网络请求，缓存后只有冷启动时才发一次请求。

**3. userID 用 circle_be 的 UUID**
```typescript
// OpenIM userID = circle_be User.id (UUID)
// 例如: "3f2a1b4c-8d9e-4f5a-b6c7-d8e9f0a1b2c3"
```
意义：两边 ID 完全一致，不需要维护 id 映射表，查询更简单。

**封装的接口：**

| 方法 | 调用时机 | OpenIM API |
|------|----------|------------|
| `registerUser(userID, nickname, avatarUrl)` | 用户注册时 | `POST /user/user_register` |
| `getUserToken(userID, platformID)` | 用户登录/注册时 | `POST /auth/get_user_token` |
| `createGroup(groupID, name, ownerID, memberIDs)` | 创建 Squad 时（下一阶段） | `POST /group/create_group` |
| `addGroupMembers(groupID, userIDs)` | 加入 Squad 时（下一阶段） | `POST /group/invite_user_to_group` |
| `removeGroupMember(groupID, userID)` | 退出 Squad 时（下一阶段） | `POST /group/kick_group` |

---

### 3.2 `src/auth/auth.service.ts` — 登录/注册改动

**注册时同步用户到 OpenIM（fire-and-forget）：**
```typescript
// 注册成功后，异步通知 OpenIM，不阻塞响应
this.openim
  .registerUser(user.id, user.nickname, user.avatarUrl)
  .catch((err) => this.logger.warn(`OpenIM registerUser failed: ${err?.message}`));
```
意义：OpenIM 注册失败不应该导致业务注册失败（非核心依赖），所以用 fire-and-forget。

**登录/注册时并行获取三个 token：**
```typescript
const [accessToken, refreshToken, imToken] = await Promise.all([
  this.signAccessToken(userId, username, role),         // 业务 JWT
  this.refreshTokenService.create(userId, sessionContext), // 刷新 token
  this.openim.getUserToken(userId).catch((err) => {     // IM token
    this.logger.warn(`OpenIM getUserToken failed: ${err?.message}`);
    return ''; // 失败不影响业务登录
  }),
]);
return { accessToken, refreshToken, imToken };
```
意义：三个 token 之间没有依赖关系，并行执行减少总耗时。OpenIM 挂掉不影响业务登录。

---

### 3.3 `src/auth/dto/auth-tokens.dto.ts` — 响应结构变更

```typescript
// 登录/注册响应新增 imToken 字段
export class AuthTokensDto {
  accessToken: string;   // 业务 JWT，有效期 15 分钟
  refreshToken: string;  // 刷新 token，有效期 7 天
  imToken: string;       // OpenIM SDK 登录用，OpenIM 未配置时为空字符串 ""
}
```

---

### 3.4 环境变量

```bash
# .env.development
OPENIM_API_URL=http://localhost:10002      # OpenIM Server 地址
OPENIM_ADMIN_SECRET=openIM123             # OpenIM 管理员密钥（见 docker-compose）
OPENIM_CALLBACK_SECRET=                    # 可选：before-send 回调共享密钥（见 3.5）
```

---

### 3.5 信誉发言闸门回调（OpenIM before-send callback）

OpenIM 在投递消息前会回调 circle_be，由后端按发送者信誉分决定放行还是拦截。

**端点**（`src/credit/openim-credit-callback.controller.ts`）：

| 路径 | 触发时机 |
|------|----------|
| `POST /openim-callback/callbackBeforeSendSingleMsgCommand` | 单聊发送前 |
| `POST /openim-callback/callbackBeforeSendGroupMsgCommand` | 群聊发送前 |

**判定**：解析 `sendID` → 还原成 circle_be 用户 → 查信誉分。低于阈值(默认 60，见
`CreditPolicyService`)返回拒绝(`errCode 5001`)，否则放行。缺失/无法解析的 `sendID`
一律**放行**(fail-open，不因闸门故障阻断正常消息)。

**鉴权**（`OpenimCallbackGuard`）：OpenIM 默认不对回调签名，端点又直连数据库。设置
`OPENIM_CALLBACK_SECRET` 后，后端要求每次回调带匹配密钥，否则 401；**不设则为 no-op**
(适用于回调路径已做网络隔离、仅 OpenIM 可达的部署)。密钥可走两个通道：

- 请求头 `x-openim-callback-secret: <secret>`
- 或查询参数 `?token=<secret>`

**配置步骤**：

1. 生成随机串：`openssl rand -hex 32`，写入对应环境的 `.env.${NODE_ENV}` 的
   `OPENIM_CALLBACK_SECRET`，重启后端。
2. 让 OpenIM 带上密钥（二选一）：
   - **方式 A（推荐，最兼容）**：在仅 OpenIM 可达的网关(nginx)上给
     `location /openim-callback/` 注入 `proxy_set_header x-openim-callback-secret "<secret>"`，
     app 层校验作为纵深防御。
   - **方式 B**：若你的 OpenIM 版本支持配置每条回调的**完整 URL**，在末尾加
     `?token=<secret>`。注意「基址自动拼命令名」风格的版本会把 query 拼坏，此时用方式 A。
3. 验证：不带密钥应 401，带正确密钥应 200。

> ⚠️ 两侧密钥必须完全一致；轮换时先同步再重启，避免中间态把正常消息拦成 401
> (守卫对鉴权失败 fail-closed)。

---

## 四、完整交互流程

### 4.1 注册流程

```
前端                         circle_be                        OpenIM Server
 │                               │                                  │
 │  POST /auth/register          │                                  │
 │──────────────────────────────>│                                  │
 │                               │ 1. 检查 username 唯一性           │
 │                               │ 2. argon2 加密密码               │
 │                               │ 3. 创建 User（PostgreSQL）        │
 │                               │                                  │
 │                               │ [并行]                           │
 │                               │ 4a. 签发 accessToken (JWT 15m)   │
 │                               │ 4b. 创建 refreshToken (DB 7d)    │
 │                               │ 4c. 调用 OpenIM getUserToken ────>│
 │                               │<──────────────────── imToken ───│
 │                               │                                  │
 │                               │ [fire-and-forget，不等结果]       │
 │                               │ 5. 调用 OpenIM registerUser ─────>│
 │                               │     （失败只打 warn 日志）         │
 │                               │                                  │
 │  { accessToken,               │                                  │
 │    refreshToken,              │                                  │
 │    imToken }                  │                                  │
 │<──────────────────────────────│                                  │
 │                               │                                  │
 │ 6. 用 imToken 初始化 OpenIM SDK，建立 WebSocket 长连接             │
 │────────────────────────────────────────────────────────────────>│
```

### 4.2 登录流程

```
前端                         circle_be                        OpenIM Server
 │                               │                                  │
 │  POST /auth/login             │                                  │
 │──────────────────────────────>│                                  │
 │                               │ 1. 查 User 验证密码               │
 │                               │ 2. 检查 status === ACTIVE         │
 │                               │                                  │
 │                               │ [并行]                           │
 │                               │ 3a. 签发 accessToken (JWT 15m)   │
 │                               │ 3b. 创建 refreshToken (DB 7d)    │
 │                               │ 3c. 调用 OpenIM getUserToken ────>│
 │                               │<──────────────────── imToken ───│
 │                               │                                  │
 │  { accessToken,               │                                  │
 │    refreshToken,              │                                  │
 │    imToken }                  │                                  │
 │<──────────────────────────────│                                  │
 │                               │                                  │
 │ 4. 用 imToken 初始化 OpenIM SDK                                   │
 │────────────────────────────────────────────────────────────────>│
```

### 4.3 发送消息流程（登录后）

```
前端（用户 A）                OpenIM Server              前端（用户 B）
 │                                 │                           │
 │ OpenIM SDK 发送消息              │                           │
 │────────────────────────────────>│                           │
 │                                 │ 存储消息（MongoDB）        │
 │                                 │ 推送消息给在线用户          │
 │                                 │──────────────────────────>│
 │                                 │                           │ 收到消息
 │<── 发送成功回执 ─────────────────│                           │
```

**注意：聊天消息完全在前端 SDK 和 OpenIM Server 之间流转，不经过 circle_be。**

### 4.4 Token 刷新流程

```
前端                         circle_be
 │                               │
 │  accessToken 过期（401）       │
 │  POST /auth/refresh           │
 │  body: { refreshToken }       │
 │──────────────────────────────>│
 │                               │ 验证 refreshToken 有效性（DB 查询）
 │                               │ 旋转 refreshToken（旧的失效，生成新的）
 │                               │ 签发新 accessToken
 │                               │
 │  { accessToken,               │
 │    refreshToken (新) }        │
 │<──────────────────────────────│
 │                               │
 │ 注意：refresh 不会返回新的 imToken
 │ imToken 有效期比 accessToken 长，通常不需要刷新
```

---

## 五、前端集成要点

### 5.1 存储三个 token

```typescript
// 登录/注册成功后
const { accessToken, refreshToken, imToken } = response.data;

// accessToken: 每次 API 请求放在 Authorization header
// refreshToken: 存 SecureStore，accessToken 过期后用来换新的
// imToken: 传给 OpenIM SDK 登录
```

### 5.2 OpenIM SDK 初始化

```typescript
import { OpenIMSDK } from 'open-im-sdk-rn';

// 1. 初始化 SDK
await OpenIMSDK.initSDK({
  platformID: 2, // Android=2, iOS=1
  apiAddr: 'http://your-server:10002',
  wsAddr: 'ws://your-server:10001',
  // ...
});

// 2. 用 imToken 登录
await OpenIMSDK.login({
  userID: currentUser.id,  // circle_be 的 User.id
  token: imToken,
});
```

### 5.3 OpenIM 未配置时的处理

```typescript
// imToken 为空字符串时，跳过 OpenIM SDK 初始化
if (imToken) {
  await OpenIMSDK.login({ userID, token: imToken });
}
```

---

## 六、职责边界总结

| 功能 | 谁负责 |
|------|--------|
| 用户注册/登录/权限 | circle_be（PostgreSQL） |
| 帖子、评论、点赞 | circle_be（PostgreSQL） |
| 好友关系（业务层） | circle_be（PostgreSQL） |
| Squad 元数据 | circle_be（PostgreSQL） |
| 业务通知（点赞/评论） | circle_be（PostgreSQL） |
| 实时消息收发 | OpenIM Server（MongoDB） |
| 消息历史存储 | OpenIM Server（MongoDB） |
| 群聊（IM 层） | OpenIM Server |
| 在线状态、输入状态 | OpenIM Server |
| 离线推送 | OpenIM Server（通过 Webhook 回调） |
| 媒体文件存储 | MinIO（OpenIM docker-compose 中已有） |

---

## 七、尚未实现（下一阶段）

- [ ] 创建/解散 Squad 时同步 OpenIM Group
- [ ] 加入/退出 Squad 时同步 OpenIM Group 成员
- [ ] MinIO 文件上传（头像、图片的 presigned URL）
- [ ] 离线推送 Webhook（OpenIM 回调 circle_be，再推 APNs/FCM）
- [ ] 好友关系同步到 OpenIM（控制谁能直接发消息）
