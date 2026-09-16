# Frontend API Integration Guide

> Base URL: `http://localhost:3000`（开发环境）
> 所有请求和响应均为 `application/json`

---

## 目录

1. [认证机制](#认证机制)
2. [Auth 接口](#auth-接口)
3. [User 接口](#user-接口)
4. [Upload 接口](#upload-接口)
5. [Friend 接口](#friend-接口)
6. [Coin 接口](#coin-接口)
7. [Note 接口](#note-接口)
8. [Circle 接口](#circle-接口)
9. [Circle Plaza 接口](#circle-plaza-接口)
10. [Circle Invitation 接口](#circle-invitation-接口)
11. [Group 接口](#group-接口)
12. [Collections 接口](#collections-接口)
13. [错误处理](#错误处理)
14. [前端集成建议](#前端集成建议)

---

## 认证机制

### Token 说明

登录/注册成功后会返回三个 token：

| Token | 用途 | 有效期 |
|---|---|---|
| `accessToken` | 所有业务 API 请求的凭证 | 15 分钟 |
| `refreshToken` | `accessToken` 过期后用于换新 | 7 天 |

### 如何携带 accessToken

所有需要登录的接口，在请求头加：

```
Authorization: Bearer <accessToken>
```

### Token 刷新流程

```
1. 发请求 → 收到 401
2. 用 refreshToken 调用 POST /auth/refresh
3. 拿到新的 accessToken 和 refreshToken（旧的失效）
4. 用新 accessToken 重试原请求
```

---

nickname": "Test User",       // 可选，1-30位，默认同username
  "email": "user@example.com",   // 可选
  "phoneNumber": "+8613800138000" // 可选
}
```

**Response 201：**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "c8c1f46b2b9c..."
}
```

> 聊天不再需要独立的 IM token：`/chat-ws` 用同一个 `accessToken` 握手（见
> [self-hosted-chat.md](self-hosted-chat.md)）。

---

### 登录

```
POST /auth/login
```

**Request Body：**
```json
{
  "identifier": "testuser",
  "password": "password123"
}
```

`identifier` 可填写邮箱或用户 ID。

**Response 201：** 同注册

**错误：**
- `403` — 用户名/密码错误，或账号未激活

---

### 刷新 Token

```
POST /auth/refresh
```

**Request Body：**
```json
{
  "refreshToken": "c8c1f46b2b9c..."
}
```

**Response 201：**
```json
{
  "accessToken": "eyJhbGci...",
  "refreshToken": "新的refreshToken（旧的立即失效）"
}
```

---

### 登出

```
POST /auth/logout
```

**Request Body：**
```json
{
  "refreshToken": "c8c1f46b2b9c..."
}
```

**Response 200：** `{}`

---

### 获取当前用户信息

```
GET /auth/me
Authorization: Bearer <accessToken>
```

**Response 200：** 返回完整用户信息（见 [User 对象结构](#user-对象结构)）

---

### 修改密码

```
POST /auth/change-password
Authorization: Bearer <accessToken>
```

**Request Body：**
```json
{
  "oldPassword": "password123",
  "newPassword": "newpassword456"  // 6-64位
}
```

**Response 200：** `{}`

> 修改密码后所有设备的 refreshToken 全部失效，需要重新登录。

---

### 查看登录设备列表

```
GET /auth/sessions
Authorization: Bearer <accessToken>
```

**Response 200：**
```json
[
  {
    "id": "uuid",
    "deviceName": "iPhone 15 Pro",
    "ip": "192.168.1.1",
    "userAgent": "Mozilla/5.0...",
    "createdAt": "2026-04-07T00:00:00.000Z",
    "lastUsedAt": "2026-04-07T12:00:00.000Z"
  }
]
```

---

### 登出所有设备

```
POST /auth/logout-all
Authorization: Bearer <accessToken>
```

**Response 200：** `{}`
## Auth 接口

### 注册

```
POST /auth/register
```

**Request Headers（可选）：**
```
x-device-name: iPhone 15 Pro    // 设备名，用于会话管理
```

**Request Body：**
```json
{
  "username": "testuser",        // 必填，4-20位
  "password": "password123",     // 必填，6-64位
  "
---

## User 接口

### User 对象结构

```json
{
  "id": "3f2a1b4c-8d9e-4f5a-b6c7-d8e9f0a1b2c3",
  "accountId": "ab12cd",
  "username": "testuser",
  "nickname": "Test User",
  "avatarUrl": "http://localhost:9000/circle/avatars/xxx.jpg",
  "avatarFrame": null,
  "cover": null,
  "email": "user@example.com",
  "phoneNumber": "+8613800138000",
  "wechat": null,
  "qq": null,
  "whatsup": null,
  "persona": "Full-stack developer",
  "helloWords": "Hey there!",
  "birthday": "2000-01-01T00:00:00.000Z",
  "gender": "unset",
  "role": "USER",
  "status": "ACTIVE",
  "lastOnline": "2026-04-07T00:00:00.000Z",
  "createdAt": "2026-04-01T00:00:00.000Z",
  "updatedAt": "2026-04-07T00:00:00.000Z"
}
```

**gender 枚举值：** `male` | `female` | `other` | `unset`

**status 枚举值：** `ACTIVE` | `BANNED` | `DELETED`

---

### 获取用户信息

```
GET /user/:id
Authorization: Bearer <accessToken>
```

**Response 200：** User 对象

---

### 按账号搜索用户（添加好友）

```
GET /user/search/account?accountId=jimmy
Authorization: Bearer <accessToken>
```

> 用于普通登录用户按 `accountId` 精确搜索目标用户。  
> 这不是 admin 用户列表接口，不支持分页模糊检索。

**Response 200：**
```json
{
  "id": "3f2a1b4c-8d9e-4f5a-b6c7-d8e9f0a1b2c3",
  "accountId": "jimmy",
  "nickname": "Jimmy",
  "avatarUrl": "http://10.0.0.195:9000/circle/avatars/xxx.jpg",
  "avatarFrame": null,
  "cover": null,
  "wechat": null,
  "qq": null,
  "whatsup": null,
  "persona": "Full-stack developer",
  "helloWords": "Hey there!",
  "birthday": "2000-01-01T00:00:00.000Z",
  "gender": "unset",
  "role": "USER",
  "status": "ACTIVE",
  "lastOnline": "2026-04-07T00:00:00.000Z",
  "createdAt": "2026-04-01T00:00:00.000Z",
  "updatedAt": "2026-04-07T00:00:00.000Z"
}
```

**未找到时：**
```json
null
```

---

### 更新个人资料

```
PATCH /user/:id
Authorization: Bearer <accessToken>
```

> 只能修改自己的资料（或 admin 修改任意用户）

**Request Body（所有字段均可选）：**
```json
{
  "nickname": "新昵称",
  "avatarUrl": "http://localhost:9000/circle/avatars/xxx.jpg",
  "avatarFrame": "http://localhost:9000/circle/frames/xxx.png",
  "cover": "http://localhost:9000/circle/covers/xxx.jpg",
  "email": "new@example.com",
  "phoneNumber": "+8613900139000",
  "wechat": "wxid_xxx",
  "qq": "123456789",
  "whatsup": "Coding every day",
  "persona": "Full-stack developer",
  "helloWords": "Hey there!",
  "birthday": "2000-01-01",
  "gender": "male"
}
```

**Response 200：** 更新后的 User 对象

---

### 注销账号

```
DELETE /user/:id
Authorization: Bearer <accessToken>
```

> 软删除，status 变为 `DELETED`，只能删除自己。
> 管理员删除用户必须走审计状态接口：
> `PATCH /admin/users/:id/status`，请求体传 `status: "DELETED"`、`reason` 和 `confirmationAccountId`。

**Response 200：** User 对象（status 为 DELETED）

---

## Upload 接口

### 获取预签名上传 URL（上传头像/图片/视频）

```
POST /upload/presign
Authorization: Bearer <accessToken>
```

**Request Body：**
```json
{
  "filename": "avatar.jpg",
  "contentType": "image/jpeg",
  "folder": "avatars"
}
```

**contentType 允许值：**
```
image/jpeg | image/png | image/webp | image/gif
video/mp4 | video/quicktime | video/x-m4v
```

**folder 允许值：**
```
avatars   — 用户头像（公开）
covers    — 封面图（公开）
posts     — 帖子 / 动态图片视频（公开）
friends   — 好友申请照片（公开）
notes     — 笔记图片/视频（私有）
chat      — 聊天媒体（私有）
```

> `fileUrl` 只对公开目录（与桶策略同源：`PUBLIC_READ_UPLOAD_FOLDERS`）有值，可直接读取、可直接写进资料/圈子/帖子。
> `notes`、`chat` 是私有目录：对象直连会被拒绝，`fileUrl` **固定为 `null`**，必须保存 `key`，读取走对应接口按 key 签发的短时 URL。
> 客户端解析 presign 响应时 `fileUrl` 要按可空处理（私有目录不再有任何可存的直链）。

**Response 201（公开目录）：**
```json
{
  "uploadUrl": "http://localhost:9000/circle/avatars/uuid.jpg?X-Amz-Algorithm=...（5分钟内有效，视频30分钟）",
  "fileUrl": "http://localhost:9000/circle/avatars/uuid.jpg",
  "key": "avatars/uuid.jpg"
}
```

**Response 201（私有目录 `notes` / `chat`）：**
```json
{
  "uploadUrl": "http://localhost:9000/circle/notes/user-1/uuid.jpg?X-Amz-Algorithm=...",
  "fileUrl": null,
  "key": "notes/user-1/uuid.jpg"
}
```

---

### 上传文件（直传 MinIO，不经过后端）

```
PUT <uploadUrl>
Content-Type: image/jpeg   // 必须与申请时的 contentType 一致
Body: <文件二进制内容>
```

> 这一步直接请求 MinIO，不需要 Authorization header。

**Response 200：** 空 body，HTTP 200 表示上传成功

---

### 完整上传头像示例

```typescript
// Step 1: 获取预签名 URL
const { uploadUrl, fileUrl } = await api.post('/upload/presign', {
  filename: 'avatar.jpg',
  contentType: 'image/jpeg',
  folder: 'avatars',
});

// Step 2: 直传文件到 MinIO
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob,
});

// Step 3: 保存 URL 到用户资料
await api.patch(`/user/${userId}`, { avatarUrl: fileUrl });
```

---

## Friend 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/friend`

---

### 数据结构

#### FriendProfile 对象（好友列表条目）

```json
{
  "id": "uuid",
  "accountId": "ab12cd",
  "nickname": "张三",
  "avatarUrl": "http://10.0.0.195:9000/circle/avatars/xxx.jpg",
  "avatarFrame": null,
  "gender": "male",
  "lastOnline": "2026-04-09T10:00:00.000Z",
  "friendsSince": "2026-04-01T00:00:00.000Z"
}
```

#### FriendStatus 对象（关系状态）

```json
{
  "status": "NONE",
  "requestId": null
}
```

**status 枚举值：**

| 值 | 含义 |
|---|---|
| `NONE` | 无关系 |
| `PENDING_SENT` | 我发出了申请，等待对方确认 |
| `PENDING_RECEIVED` | 对方向我发了申请 |
| `ACCEPTED` | 已是好友 |
| `BLOCKED` | 有拉黑关系（任意一方） |

> `requestId` 在 `PENDING_SENT` / `PENDING_RECEIVED` / `ACCEPTED` 时为申请/好友记录的 ID，用于 accept/reject/cancel 操作。

---

### 好友列表

```
GET /friend
```

**Response 200：** `FriendProfile[]`

---

### 删除好友

```
DELETE /friend/:friendUserId
```

**Response 204：** 无内容

---

### 设置好友备注

```
PATCH /friend/:friendUserId/remark
```

**Request Body：**
```json
{
  "remark": "高中同学小王"
}
```

> 传 `null` 或不传 `remark` 字段 → 清除备注

**Response 204：** 无内容

---

### 查询与某用户的关系状态

```
GET /friend/status/:targetId
```

> 进入任意用户主页时调用，用于决定显示"加好友"/"已是好友"/"待确认"等按钮状态

**Response 200：** `FriendStatus` 对象

---

### 发送好友申请

```
POST /friend/requests
```

**Request Body：**
```json
{
  "targetId": "uuid-of-target-user",
  "message": "我是张三，加个好友吧",   // 可选，最多 200 字
  "remark": "met at school",          // 可选，发送者自己的好友备注，最多 50 字
  "tagIds": ["uuid-of-tag"]           // 可选，发送者自己的好友标签 id 列表
}
```

> `remark` 会先作为 pending metadata 存在请求上；当对方接受时，会写入好友记录中发送者自己的备注槽。  
> `tagIds` 会先挂到请求上；当对方接受时，会创建对应的 `FriendTagOnFriend` 记录。  
> 拒绝或撤回只会保留请求/动态历史，不会把 pending metadata 写入好友关系。

**Response 204：** 无内容

**错误：**
- `400` — 向自己发申请
- `403` — 有拉黑关系
- `404` — 目标用户不存在
- `409` — 已是好友，或当前已有 PENDING 申请
- `429` — 发送频率过高（30次/15分钟）

---

### 好友动态列表

```
GET /friend/activities
```

> 「新朋友」收件箱的唯一数据源：收到的申请（`REQUEST_RECEIVED`）、我发出的申请（`REQUEST_SENT`）以及通过/拒绝/撤回的结果都在这条动态流里。`requestState` 为 `PENDING` 时用 `requestId` 调接受 / 拒绝 / 撤回。旧的 `GET /friend/requests/incoming`、`GET /friend/requests/outgoing` 已删除。

**Response 200：**
```json
[
  {
    "id": "activity-uuid",
    "type": "REQUEST_RECEIVED",
    "requestId": "request-uuid",
    "requestState": "PENDING",
    "messageSnapshot": "你好，交个朋友",
    "readAt": null,
    "createdAt": "2026-04-08T12:00:00.000Z",
    "counterparty": {
      "id": "user-uuid",
      "accountId": "jimmy",
      "nickname": "Jimmy",
      "avatarUrl": "http://10.0.0.195:9000/circle/avatars/xxx.jpg"
    }
  }
]
```

> 用于“新的朋友”页，按时间倒序返回好友申请相关动态。  
> 已处理的动态不会消失。

---

### 好友动态未读数

```
GET /friend/activities/unread-count
```

**Response 200：**
```json
{ "count": 3 }
```

> 用于联系人 tab 红点。

---

### 获取单条好友动态详情

```
GET /friend/activities/:activityId
```

**Response 200：** 同 `FriendActivity`

---

### 标记单条好友动态已读

```
POST /friend/activities/:activityId/read
```

**Response 204：** 无内容

> 只标记这一条，不会批量清空未读。

---

### 接受好友申请

```
POST /friend/requests/:requestId/accept
```

**Response 204：** 无内容

> 接受时会把该请求上的 sender remark 写入好友关系中 sender 对应的备注槽，并把 pending tag ids 转成 active `FriendTagOnFriend` 关联。

**错误：**
- `404` — 申请不存在或已处理
- `403` — 达到好友上限（普通用户 1000，MEMBER 5000）

---

### 拒绝好友申请

```
POST /friend/requests/:requestId/reject
```

**Response 204：** 无内容

> 被拒绝后对方仍可重新发申请；请求历史保留，但不会应用 pending remark/tag metadata。

---

### 撤回好友申请

```
DELETE /friend/requests/:requestId
```

**Response 204：** 无内容

> 不会删除历史动态，只会把请求状态改为 `WITHDRAWN`，并给对方生成“已撤回”动态。  
> 撤回不会把 pending remark/tag metadata 写入好友关系。

---

### 好友标签

标签是用户私有的分类标签（如"高中同学"、"同事"），只有自己能看到。

#### 获取我的所有标签

```
GET /friend/tags
```

**Response 200：**
```json
[
  {
    "id": "uuid",
    "ownerID": "uuid",
    "name": "高中同学",
    "color": "#FF6B6B",
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
]
```

#### 创建标签

```
POST /friend/tags
```

**Request Body：**
```json
{
  "name": "高中同学",
  "color": "#FF6B6B"   // 可选，十六进制颜色
}
```

**Response 201：** 创建的标签对象

#### 删除标签

```
DELETE /friend/tags/:tagId
```

**Response 204：** 无内容（同时移除该标签在所有好友上的关联）

#### 给好友打标签

```
POST /friend/:friendUserId/tags
```

**Request Body：**
```json
{
  "tagId": "uuid-of-tag"
}
```

**Response 204：** 无内容（幂等，重复打不报错）

#### 移除好友的标签

```
DELETE /friend/:friendUserId/tags/:tagId
```

**Response 204：** 无内容

#### 查看某标签下的所有好友

```
GET /friend/tags/:tagId/friends
```

**Response 200：** `FriendProfile[]`

---

### 拉黑 / 解除拉黑

#### 拉黑用户

```
POST /friend/block
```

**Request Body：**
```json
{
  "targetId": "uuid-of-user"
}
```

**Response 204：** 无内容

> 拉黑后：现有好友关系自动解除，双方无法互相发申请

**错误：**
- `409` — 已拉黑

#### 解除拉黑

```
DELETE /friend/block/:targetId
```

**Response 204：** 无内容

#### 我的黑名单

```
GET /friend/blocked
```

**Response 200：**
```json
[
  {
    "id": "uuid",
    "accountId": "ab12cd",
    "nickname": "某用户",
    "avatarUrl": null,
    "blockedAt": "2026-04-09T00:00:00.000Z"
  }
]
```

---

### 典型交互流程

#### 添加好友完整流程

```
用户 A 查看用户 B 的主页
  → GET /friend/status/:B_userId       # 获取当前关系
  ← { status: "NONE" }                 # 显示"加好友"按钮

用户 A 点击"加好友"
  → POST /friend/requests              # 发送申请
  ← 204

用户 B 收到通知，打开「新朋友」动态流
  → GET /friend/activities
  ← [{ type: "REQUEST_RECEIVED", requestId: "req_uuid", requestState: "PENDING", counterparty: { ... } }]

用户 B 点击"接受"
  → POST /friend/requests/:req_uuid/accept
  ← 204

用户 A 再次查看状态
  → GET /friend/status/:B_userId
  ← { status: "ACCEPTED", requestId: "friend_uuid" }
```

---

## Coin 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/coin`

---

### 数据结构

#### Wallet 对象

```json
{
  "id": "uuid",
  "userID": "uuid",
  "balance": 1000,
  "updatedAt": "2026-04-09T00:00:00.000Z"
}
```

#### CoinTransaction 对象

```json
{
  "id": "uuid",
  "type": "GIFT_RECEIVED",
  "amount": 100,
  "balance": 1100,
  "note": "生日快乐！",
  "relatedID": "coin-gift-uuid",
  "createdAt": "2026-04-09T00:00:00.000Z"
}
```

**type 枚举值：**

| 值 | 含义 |
|---|---|
| `RECHARGE` | 充值（管理员操作） |
| `GIFT_SENT` | 赠送金币（扣除，amount 为负数） |
| `GIFT_RECEIVED` | 收到金币（增加，amount 为正数） |
| `REFUND` | 退款 |
| `ADJUSTMENT` | 人工调整 |

---

### 查看我的钱包余额

```
GET /coin/wallet
```

**Response 200：** Wallet 对象

> 首次访问自动创建钱包（余额为 0）

---

### 查看流水记录

```
GET /coin/transactions
```

**Response 200：** `CoinTransaction[]`（最近 50 条，倒序）

---

### 赠送金币给好友

```
POST /coin/gift
```

**Request Body：**
```json
{
  "recipientId": "uuid-of-friend",
  "amount": 100,
  "message": "生日快乐！"   // 可选，最多 100 字
}
```

**Response 204：** 无内容

**限制：**
- 单次最多 `10,000` 枚
- 每日累计最多 `50,000` 枚
- 只能赠送给好友

**错误：**
- `400` — 余额不足 / 超过单次/每日上限 / 向自己赠送
- `403` — 对方不是你的好友
- `404` — 对方用户不存在
- `429` — 操作频率过高（20次/15分钟）

---

## Note 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/note`

### NoteMedia 对象

```json
{
  "id": "uuid",
  "type": "IMAGE",
  "objectKey": "notes/user-1/file.jpg",
  "url": "http://localhost:9000/circle/notes/user-1/file.jpg",
  "mimeType": "image/jpeg",
  "size": 123456,
  "width": 1080,
  "height": 1440,
  "durationMs": null,
  "posterUrl": null,
  "sortOrder": 0
}
```

**type 枚举值：** `IMAGE` | `VIDEO`

---

### NoteSummary 对象

```json
{
  "id": "uuid",
  "title": "测试笔记",
  "contentPreview": "正文前 120 字摘要",
  "status": "ACTIVE",
  "pinned": false,
  "group": {
    "id": "uuid",
    "name": "上海"
  },
  "cover": {
    "id": "uuid",
    "type": "IMAGE",
    "url": "http://localhost:9000/circle/notes/user-1/file.jpg"
  },
  "imageCount": 2,
  "videoCount": 1,
  "mediaCount": 3,
  "createdAt": "2026-04-09T00:00:00.000Z",
  "updatedAt": "2026-04-09T12:00:00.000Z"
}
```

**status 枚举值：** `ACTIVE` | `UNLISTED` | `DELETED`

---

### NoteDetail 对象

```json
{
  "id": "uuid",
  "title": "测试笔记",
  "content": "完整正文",
  "contentPreview": "完整正文",
  "status": "ACTIVE",
  "pinned": false,
  "group": null,
  "cover": null,
  "imageCount": 2,
  "videoCount": 1,
  "mediaCount": 3,
  "createdAt": "2026-04-09T00:00:00.000Z",
  "updatedAt": "2026-04-09T12:00:00.000Z",
  "media": [
    {
      "id": "uuid",
      "type": "IMAGE",
      "objectKey": "notes/user-1/file.jpg",
      "url": "http://localhost:9000/circle/notes/user-1/file.jpg",
      "mimeType": "image/jpeg",
      "size": 123456,
      "width": 1080,
      "height": 1440,
      "durationMs": null,
      "posterUrl": null,
      "sortOrder": 0
    }
  ]
}
```

---

### 获取我的笔记列表

```
GET /note?status=ACTIVE&groupId=<uuid>&search=关键词
Authorization: Bearer <accessToken>
```

**Query 参数：**
- `status` 可选，默认返回非 `DELETED` 的笔记
- `groupId` 可选，只看某个分组
- `search` 可选，按标题/正文模糊搜索
- `page` 可选，默认 1（上限 500）
- `limit` 可选，默认 500，上限 500

**响应头：** `X-Has-More: true|false` —— 本页之后是否还有笔记。响应体始终是数组；为 `true` 时用下一个 `page` 继续拉取。`GET /note/recycle-bin`（回收站）同一分页口径与同一响应头。

**Response 200：**
```json
[
  {
    "id": "uuid",
    "title": "测试笔记",
    "contentPreview": "正文前 120 字摘要",
    "status": "ACTIVE",
    "pinned": false,
    "group": null,
    "cover": null,
    "imageCount": 2,
    "videoCount": 1,
    "mediaCount": 3,
    "createdAt": "2026-04-09T00:00:00.000Z",
    "updatedAt": "2026-04-09T12:00:00.000Z"
  }
]
```

---

### 获取笔记详情

```
GET /note/:id
Authorization: Bearer <accessToken>
```

**Response 200：** `NoteDetail`

- 主人可读自己任何未删除的笔记（含 `UNLISTED`）；其他人只能读 `available=true` 且 `status=ACTIVE` 的笔记，否则 404 `NOTE_NOT_FOUND`。收藏（`POST /note/collect`）、导出（`POST /note/:id/exports`）、复制媒体（`POST /note/:id/chat-media`）与临时聊天访客读 note-card 同一口径。
- 非主人视角：`canEdit=false`，`remark` / `collectedFrom` 为 `null`，`pinned` 恒为 `false`，`groups` 恒为 `[]`（置顶与分组是主人的私人整理标记，不随笔记外发）。

---

### 创建笔记

```
POST /note
Authorization: Bearer <accessToken>
```

**Request Body：**
```json
{
  "title": "测试笔记",
  "content": "完整正文",
  "groupId": "uuid",
  "status": "ACTIVE",
  "pinned": false,
  "media": [
    {
      "type": "IMAGE",
      "objectKey": "notes/user-1/file.jpg",
      "url": "http://localhost:9000/circle/notes/user-1/file.jpg",
      "mimeType": "image/jpeg",
      "size": 123456,
      "width": 1080,
      "height": 1440,
      "sortOrder": 0
    },
    {
      "type": "VIDEO",
      "objectKey": "notes/user-1/file.mp4",
      "mimeType": "video/mp4",
      "size": 3456789,
      "durationMs": 12000,
      "posterUrl": "http://localhost:9000/circle/notes/user-1/file-cover.jpg",
      "sortOrder": 1
    }
  ]
}
```

> `media[].url` 可省：`notes` 是私有目录，presign 的 `fileUrl` 是 `null`，只需回传 `objectKey`，
> 服务端按它拼出落库用的持久地址（读取一律按 `objectKey` 现签短时 URL）。
> 传了的话仍须是本站存储地址（编辑时回传读到的签名 URL 也可以，服务端会去掉签名 query）。

**Response 201/200：** `NoteDetail`

---

### 更新笔记

```
PATCH /note/:id
Authorization: Bearer <accessToken>
```

**Request Body：** 与创建笔记相同。  
说明：媒体数组按“完整覆盖”处理，前端应传最新完整顺序。

**Response 200：** `NoteDetail`

---

### 置顶 / 取消置顶

```
PATCH /note/:id/pin
Authorization: Bearer <accessToken>
```

**Request Body：**
```json
{
  "pinned": true
}
```

**Response 200：**
```json
{
  "id": "uuid",
  "pinned": true
}
```

---

### 删除笔记

```
DELETE /note/:id
Authorization: Bearer <accessToken>
```

> 软删除，`status` 更新为 `DELETED`

**Response 204：** 无内容

---

### 获取笔记分组

```
GET /note/group
Authorization: Bearer <accessToken>
```

**Response 200：**
```json
[
  {
    "id": "uuid",
    "ownerID": "uuid",
    "name": "上海",
    "sortOrder": 0,
    "noteCount": 12
  }
]
```

---

### 新建笔记分组

```
POST /note/group
Authorization: Bearer <accessToken>
```

**Request Body：**
```json
{
  "name": "上海"
}
```

**Response 200：** `NoteGroup`

---

### 修改笔记分组名称

```
PATCH /note/group/:id
Authorization: Bearer <accessToken>
```

**Request Body：**
```json
{
  "name": "深圳"
}
```

**Response 200：** `NoteGroup`

---

### 删除笔记分组

```
DELETE /note/group/:id
Authorization: Bearer <accessToken>
```

> 删除分组时，该分组下的笔记会自动变为未分组（`groupId = null`）

**Response 204：** 无内容

---

## Circle 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/circle`
> 下文「响应」均指统一信封 `{ code, message, data }` 中的 `data`；业务错误带 `errorCode`。
> 限流（按 IP）：写方法（POST / PATCH / PUT / DELETE）40 次 / 15 分钟，读方法 600 次 / 15 分钟，另有全局 300 次 / 分钟兜底。

### Circle 对象

```json
{
  "id": "uuid",
  "name": "周末露营",
  "description": "圈子简介（同时是群公告）",
  "avatarUrl": "http://localhost:9000/circle/avatars/user-1/xxx.jpg",
  "currentIconUrl": null,
  "cover": null,
  "cities": ["上海"],
  "categories": ["outdoor"],
  "rules": "",
  "tags": ["露营"],
  "joinVipRestriction": null,
  "joinCreditRestriction": null,
  "joinFancyRestriction": false,
  "maxMembers": 500,
  "memberCanPost": true,
  "requiredVerifierCount": 1,
  "memberCanInvite": true,
  "groupID": "uuid",
  "memberCount": 12,
  "postCount": 3,
  "createdAt": "2026-09-01T00:00:00.000Z"
}
```

- `GET /circle/my` 的每一项额外带 `myRole`：`OWNER` | `ADMIN` | `MEMBER` | `null`。
- 圈子详情（`POST /circle`、`GET /circle/:id`、`PATCH /circle/:id` 的响应）额外带 `myRole` 与 `myStatus`：`ACTIVE` | `PENDING` | `REJECTED` | `null`。

### 路由

| 方法 | 路径 | 请求 | 响应 | 关键规则 |
|---|---|---|---|---|
| POST | `/circle` | 建圈字段（见下） | 圈子详情 | 会员体系开启后普通用户不可建圈（`CIRCLE_VIP_REQUIRED`）；每人最多建 20 个（`CIRCLE_CREATE_LIMIT_REACHED`）；`avatarUrl` 必须来自本站存储（`CIRCLE_AVATAR_URL_INVALID`） |
| GET | `/circle/my` | query：`tab` 必填，`joined` \| `created` \| `applied`；`cursor` 为上一页最后一个圈子 id；`limit` 1–100 | Circle 数组（带 `myRole`） | 游标翻页；不传 `limit` 时带 `cursor` 默认 50，否则 100 |
| GET | `/circle/:id` | — | 圈子详情 | 按 id 查看未删除的圈子（不存在时 `CIRCLE_NOT_FOUND`） |
| PATCH | `/circle/:id` | 编辑字段（见下），只写传了的字段 | 圈子详情 | 仅 ACTIVE 的圈主 / 管理员（`CIRCLE_EDIT_FORBIDDEN`）；`joinVipRestriction` 不能高于圈主的会员等级（`CIRCLE_JOIN_VIP_RESTRICTION_EXCEEDS_CREATOR`） |
| POST | `/circle/:id/join` | — | `202`，申请单（见 Circle Invitation 接口） | 所有入圈都走审核 / 担保；已是成员 `CIRCLE_ALREADY_MEMBER`，已有申请 `CIRCLE_ALREADY_MEMBER_OR_PENDING`；门槛或加入额度不满足时返回 `CIRCLE_JOIN_*` |
| DELETE | `/circle/:id/leave` | — | `204` | 圈主不能退圈（`CIRCLE_OWNER_CANNOT_LEAVE`） |
| DELETE | `/circle/:id` | — | `204` | 圈主解散圈子，不可逆（`CIRCLE_OWNER_ONLY_DISSOLVE`） |
| POST | `/circle/:id/icon/upload` | `{ imageUrl, name? }`：`imageUrl` 为带协议的 URL（≤ 500），`name` ≤ 50 | `{ id, name, imageUrl }` | 仅圈主（`CIRCLE_ICON_OWNER_ONLY`）；地址必须来自本站存储；上传后即为当前图标，并替换本圈旧的自定义图标 |
| POST | `/circle/:id/icon/select` | `{ iconAssetId }`（UUID） | — | 仅圈主；只能选系统图标或本圈图标（`CIRCLE_ICON_ASSET_NOT_FOUND`） |
| POST | `/circle/:id/cover` | `{ cover }`：带协议的 URL（≤ 500） | `204` | 仅圈主；地址必须来自本站存储 |
| POST | `/circle/:id/avatar` | `{ avatarUrl }`：带协议的 URL（≤ 500） | `204` | 仅圈主；地址必须来自本站存储 |

**建圈字段**（`POST /circle`）

| 字段 | 必填 | 约束 |
|---|---|---|
| `name` | 是 | 2–20 字 |
| `categories` | 是 | 数组 ≤ 5，去重，每项 ≤ 20 字 |
| `description` | 是 | 10–500 字 |
| `avatarUrl` | 否 | 带协议的 URL，≤ 500 字符，须为本站存储地址（presign 返回的 `fileUrl`） |
| `cities` | 否 | 数组 ≤ 10，去重，每项 ≤ 50 字 |
| `rules` | 否 | ≤ 1000 字 |
| `tags` | 否 | 数组 ≤ 3，去重，每项 ≤ 30 字 |
| `joinVipRestriction` | 否 | 0–4，或 `null` 表示不限 |
| `joinCreditRestriction` | 否 | 0–100 |
| `joinFancyRestriction` | 否 | 布尔，默认 `false` |
| `maxMembers` | 否 | 10–3000；不传则按会员容量 |
| `memberCanPost` | 否 | 布尔，默认 `true` |
| `requiredVerifierCount` | 否 | 1–10；1 = 不需要担保；每张申请单创建时快照 |

**编辑字段**（`PATCH /circle/:id`）：`name`（先 trim）、`categories`、`avatarUrl`、`cities`、`rules`、`tags`、`joinVipRestriction`、`joinCreditRestriction`、`joinFancyRestriction`、`memberCanPost`、`requiredVerifierCount` 与建圈同约束，另有 `memberCanInvite`（`false` = 仅圈主 / 管理员可邀请）。区别：`description` 允许空串（0–500，用于清空群公告）；不含 `maxMembers`（容量走会员配额 / 扩容卡）；除 `joinVipRestriction`、`joinCreditRestriction` 可传 `null` 表示不限外，显式 `null` 一律 400；布尔字段必须是 JSON 布尔，`"false"` 这类字符串会被拒绝。

---

## Circle Plaza 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/circle-plaza`
> 响应均指统一信封中的 `data`；业务错误带 `errorCode`。
> 限流：每条路由有按 IP 的每分钟上限（见下表）；另外所有 POST / DELETE（包括 `feed/search` 与 `signups/read`）都计入 40 次 / 15 分钟 / IP 的广场写配额。
> 有效会员等级为 0 的普通用户看帖、发帖、报名都会被拒（`PLAZA_MEMBERSHIP_REQUIRED`）。

### PlazaPost 对象

```json
{
  "id": "uuid",
  "content": "周六一起去露营",
  "images": ["http://localhost:9000/circle/posts/user-1/xxx.jpg"],
  "tags": ["露营"],
  "city": "上海",
  "cities": ["上海"],
  "isHorn": false,
  "noteId": null,
  "restrictions": { "vipLevel": null, "creditScore": null, "fancyNumber": false },   // 互动门槛
  "signupCount": 3,
  "signedByMe": false,
  "signupRestrictions": { "vipLevel": null, "creditScore": null, "fancyNumber": false },   // 报名门槛
  "canSignup": true,
  "author": {
    "id": "uuid",
    "nickname": "Alice",
    "avatarUrl": null,
    "avatarFrame": null,
    "avatarFrameAppearance": null,
    "accountId": "ab12cd",
    "vipLevel": 2,                // 有效会员等级（按到期算）
    "membership": { },            // 公开会员外观（tier key / 名字色 / 徽章）
    "displayIcons": []
  },
  "circle": { "id": "uuid", "name": "周末露营" },
  "circles": [{ "id": "uuid", "name": "周末露营" }],
  "canInteract": true,
  "createdAt": "2026-09-01T00:00:00.000Z",
  "expiresAt": "2026-09-01T06:00:00.000Z"
}
```

`MyCirclePost`：`{ id, circleId, excerpt, firstImage, signupCount, unreadSignupCount, status, createdAt, expiresAt }`。
`PostSignupItem`：`{ userId, nickname, avatarUrl, accountId, signedAt, seen, displayIcons, recognized }`。

### 路由

| 方法 | 路径 | 请求 | 响应 | 关键规则 |
|---|---|---|---|---|
| GET | `/circle-plaza/feed` | query：`circleId`；`circleIds`（逗号分隔）；`city`（≤ 100）；`cities`（逗号分隔，≤ 4096 字符）；`page` 1–500；`limit` 1–100（默认 20）；`cursor`（≤ 200） | `{ items: PlazaPost[], total, page, limit, hasMore, nextCursor }` | 60 次 / 分钟；只返回我是 ACTIVE 成员的圈子里未过期的 ACTIVE 帖子，按没加入的圈子筛选得到空列表；城市数超过会员配额 `CITY_FILTER_QUOTA_REACHED`；带 `cursor` 时忽略 `page`，`total` 为 `null` |
| POST | `/circle-plaza/feed/search` | body：`circleId?`；`circleIds?`（≤ 50）；`cities`（必填，≤ 1000，每项 ≤ 100）；`page`、`limit`、`cursor` 同上 | 同 feed | `200`，60 次 / 分钟；城市很多时用它代替 query，规则同 feed |
| POST | `/circle-plaza/posts` | 发帖字段（见下） | PlazaPost | 10 次 / 分钟；每个目标圈子都必须是 ACTIVE 成员（`PLAZA_NOT_ACTIVE_MEMBER`）；圈子关闭成员发帖时仅圈主 / 管理员可发（`PLAZA_ADMIN_ONLY_POST`）；互动 / 报名门槛不能高于作者自己的有效等级（`PLAZA_VIP_RESTRICTION_EXCEEDS_AUTHOR`） |
| GET | `/circle-plaza/posts/:id` | — | PlazaPost | 60 次 / 分钟；不是帖子所属圈子的成员时 `PLAZA_NOT_CIRCLE_MEMBER` |
| DELETE | `/circle-plaza/posts/:id` | — | `204` | 10 次 / 分钟；仅作者（`PLAZA_DELETE_AUTHOR_ONLY`），软删除 |
| POST | `/circle-plaza/posts/:id/report` | `{ reason? }`（≤ 500） | `{ reported }` | 10 次 / 分钟；不能举报自己的帖子（`PLAZA_REPORT_SELF`） |
| POST | `/circle-plaza/posts/:id/signup` | — | `{ signed: true, signupCount }` | 30 次 / 分钟；不能报名自己的帖子（`PLAZA_SIGNUP_SELF`）；不满足报名门槛 `PLAZA_SIGNUP_INELIGIBLE` |
| DELETE | `/circle-plaza/posts/:id/signup` | — | `{ signed: false, signupCount }` | 30 次 / 分钟 |
| GET | `/circle-plaza/me/posts` | query：`page`（缺省 1，越界夹到 500） | `{ items: MyCirclePost[], total, page, limit, hasMore }` | 60 次 / 分钟；我发的帖子，带每帖未读报名数 |
| GET | `/circle-plaza/me/signups/unread-count` | — | `{ count }` | 60 次 / 分钟；报名红点 |
| GET | `/circle-plaza/me/posts/:id/signups` | — | `{ items: PostSignupItem[], recognitionOpen }` | 60 次 / 分钟；只能看自己的帖子；最多 200 条；`recognitionOpen` = 帖子已结束且尚未做过合作认可 |
| POST | `/circle-plaza/me/posts/:id/signups/read` | — | `{ count }` | 60 次 / 分钟；把该帖所有未读报名标为已读 |
| POST | `/circle-plaza/me/posts/:id/collaboration-recognitions` | `{ recipientIds }`：1–3 个，去重，每项 ≤ 64 | `{ count, recognizedUserIds }` | `200`，10 次 / 分钟；给该帖报名者合作认可，不满足条件时返回 `PLAZA_RECOGNIZE_*` |

**发帖字段**（`POST /circle-plaza/posts`）

| 字段 | 必填 | 约束 |
|---|---|---|
| `content` | 是 | 1–5000 字 |
| `images` | 否 | ≤ 9 张，每项 ≤ 500 字符，须为本站存储地址 |
| `tags` | 否 | ≤ 5，去重，每项 ≤ 30 字 |
| `circleIds` | 是（或旧字段 `circleId`） | UUID 数组 ≤ 50，去重，至少 1 个；第一个为主圈子 |
| `cities` | 否（或旧字段 `city`） | ≤ 50，去重，每项 ≤ 100 字 |
| `noteId` | 否 | UUID，关联笔记（无效时 `PLAZA_NOTE_INVALID`） |
| `isHorn` | 否 | 布尔，默认 `false` |
| `expiresInHours` | 否 | 6–168，默认 6 |
| `vipRestriction` / `signupVipRestriction` | 否 | 0–4，互动 / 报名的会员门槛 |
| `creditRestriction` / `signupCreditRestriction` | 否 | 0–100 |
| `fancyRestriction` / `signupFancyRestriction` | 否 | 布尔，默认 `false` |

---

## Circle Invitation 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/circle-invitation`
> 响应均指统一信封中的 `data`；业务错误带 `errorCode`。
> 限流：所有 POST 计入 40 次 / 15 分钟 / IP 的邀请写配额；`invite` 另有 20 次 / 分钟 / IP。

### Invitation 对象

```json
{
  "id": "uuid",
  "circleId": "uuid",
  "circleName": "周末露营",
  "applicant": { "id": "uuid", "nickname": "Bob", "avatarUrl": null, "accountId": "bob02" },
  "inviter": { "id": "uuid", "nickname": "Alice", "avatarUrl": null, "accountId": "ab12cd" },
  "requiredCount": 1,         // 建单时快照的圈子 requiredVerifierCount
  "approvedCount": 0,
  "status": "PENDING",
  "verifiers": [
    {
      "id": "uuid",
      "verifier": { "id": "uuid", "nickname": "Carol", "avatarUrl": null, "accountId": "carol03" },
      "status": "PENDING",
      "respondedAt": null
    }
  ],
  "createdAt": "2026-09-01T00:00:00.000Z"
}
```

**status 枚举值：** `PENDING` | `APPROVED` | `REJECTED` | `ADMIN_APPROVED` | `CANCELLED`；担保人 `status`：`PENDING` | `APPROVED` | `REJECTED`

### 路由

| 方法 | 路径 | 请求 | 响应 | 关键规则 |
|---|---|---|---|---|
| POST | `/circle-invitation/invite` | `{ circleId, applicantId }`（UUID） | Invitation | 20 次 / 分钟；邀请人须是圈子成员（`INVITATION_INVITER_NOT_MEMBER`）；圈子关闭成员邀请时仅圈主 / 管理员可邀请（`INVITATION_MEMBER_INVITE_DISABLED`）；对方已有进行中的申请 `INVITATION_ALREADY_PENDING`；`requiredCount` 为 1 时当场入圈 |
| GET | `/circle-invitation/pending` | query：`cursor`（上一页最后一条的 id）；`limit` 1–100（默认 50） | Invitation 数组 | 我作为担保人待处理的申请 |
| GET | `/circle-invitation/my-applications` | 同上 | Invitation 数组 | 我作为申请人的申请 |
| GET | `/circle-invitation/circle/:circleId/pending` | 同上 | Invitation 数组 | 仅 ACTIVE 的圈主 / 管理员（`INVITATION_OWNER_ADMIN_ONLY`） |
| GET | `/circle-invitation/:id` | — | Invitation | 无权查看时 `INVITATION_VIEW_FORBIDDEN` |
| GET | `/circle-invitation/:id/eligible-verifiers` | — | `{ id, nickname, avatarUrl, accountId }[]` | 仅申请人（`INVITATION_APPLICANT_ONLY`）；返回既是我好友、又是该圈 ACTIVE 成员的人 |
| POST | `/circle-invitation/:id/add-verifier` | `{ verifierId }`（UUID） | `204` | 仅申请人；担保人须是好友（`INVITATION_VERIFIER_NOT_FRIEND`）且是圈子成员（`INVITATION_VERIFIER_NOT_MEMBER`）；名额已满 `INVITATION_SLOTS_FILLED`；重复添加 `INVITATION_ALREADY_VERIFIER` |
| POST | `/circle-invitation/:id/respond` | `{ approve }`（布尔） | `204` | 担保人同意 / 拒绝；我没有待处理的担保 `INVITATION_NO_PENDING_VERIFICATION`；申请已结束 `INVITATION_NOT_PENDING` |
| POST | `/circle-invitation/:id/admin-approve` | — | `204` | ACTIVE 的圈主 / 管理员跳过担保直接通过（`INVITATION_OWNER_ADMIN_ONLY`） |

---

## Group 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/group`
> 响应均指统一信封中的 `data`；业务错误带 `errorCode`。
> `:groupID` 是圈子群聊的 id（`Circle.groupID`）；解析不到对应的圈子群时，邀请与移除接口返回 `{ handled: false }`。
> 限流：POST / DELETE 计入 60 次 / 15 分钟 / IP，举报另计 10 次 / 小时 / IP；各路由还有按 IP 的每分钟上限（见下表）。

| 方法 | 路径 | 请求 | 响应 | 关键规则 |
|---|---|---|---|---|
| DELETE | `/group/:groupID/leave` | — | `204` | 30 次 / 分钟；群主不能退群（`GROUP_OWNER_CANNOT_LEAVE`） |
| POST | `/group/:groupID/members/invite` | `{ userIDs }`：≤ 100，去重，每项 1–128 字符 | `{ handled }` | 20 次 / 分钟；仅 ACTIVE 的群主 / 管理员（`GROUP_MANAGER_ONLY`）；已是成员的自动跳过；对方隐私设置不允许被拉群或双方存在拉黑时 `GROUP_INVITE_NOT_ALLOWED` |
| DELETE | `/group/:groupID/members/:userID` | — | `{ handled }` | 30 次 / 分钟；群主可移除任何成员，管理员只能移除普通成员（`GROUP_MANAGER_ONLY`）；移除自己请用 leave（`GROUP_USE_LEAVE_ENDPOINT`） |
| PATCH | `/group/:groupID/members/:userID/role` | `{ role }`：`ADMIN` \| `MEMBER` | `{ handled: true, role }` | 20 次 / 分钟；仅群主（`GROUP_MANAGER_ONLY`），不能改自己的角色 |
| POST | `/group/:groupID/report` | 举报字段（见下） | `204` | 10 次 / 分钟；仅 ACTIVE 群成员可举报（`GROUP_REPORT_NOT_ACTIVE`）；同一类别已有待处理举报时 `GROUP_REPORT_DUPLICATE` |

**举报字段**：`category` = `harassment` | `spam` | `impersonation` | `fraud` | `other`；`description` 1–500 字；`evidence` 可选，≤ 5 项、去重、每项 ≤ 500 字符且不含 `<` `>`，http(s) 形式的证据必须来自本站存储（对象 key 原样放行）。

---

## Collections 接口

> 所有接口均需 `Authorization: Bearer <accessToken>`
> Base path: `/collections`
> 响应均指统一信封中的 `data`；业务错误带 `errorCode`。

### UserCollection 对象

```json
{
  "id": "uuid",
  "userID": "uuid",
  "type": "NOTE",
  "title": "收藏的笔记",
  "summary": null,
  "sourceID": "uuid",
  "payload": {},
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z"
}
```

**type 枚举值：** `CHAT` | `VIDEO` | `VOICE` | `MESSAGE` | `NOTE`

| 方法 | 路径 | 请求 | 响应 | 关键规则 |
|---|---|---|---|---|
| GET | `/collections` | query：`type`（可选） | UserCollection 数组 | 按创建时间倒序，最多 100 条 |
| POST | `/collections` | `{ type, title, summary?, sourceID?, payload? }`：`title` ≤ 80，`summary` ≤ 240，`sourceID` ≤ 120，`payload` 为对象 | UserCollection | 每人最多 500 条（`COLLECTION_LIMIT`）；收藏聊天消息时服务端按 `sourceID` 校验这条消息我仍可见，不信任客户端自报的快照（`COLLECTION_INVALID_MESSAGE_SOURCE`）；阅后即焚会话里别人发的消息不可收藏（`COLLECTION_EPHEMERAL_FORBIDDEN`） |
| DELETE | `/collections/:id` | — | `204` | 只能删自己的收藏，否则 `COLLECTION_NOT_FOUND` |

---

## 错误处理

所有错误响应格式：

```json
{
  "statusCode": 400,
  "message": "错误描述",
  "error": "Bad Request"
}
```

| HTTP 状态码 | 含义 | 常见场景 |
|---|---|---|
| `400` | 请求参数错误 | 字段格式不对、缺少必填字段 |
| `401` | 未授权 | accessToken 缺失或过期 |
| `403` | 无权限 | 密码错误、账号禁用、操作他人数据 |
| `404` | 资源不存在 | 用户不存在 |
| `409` | 冲突 | 用户名已被注册 |

---

## 前端集成建议

### 1. 存储 Token

```typescript
// 推荐用 SecureStore（Expo）或 Keychain 存储，不要放 AsyncStorage
import * as SecureStore from 'expo-secure-store';

await SecureStore.setItemAsync('accessToken', accessToken);
await SecureStore.setItemAsync('refreshToken', refreshToken);
```

### 2. Axios 拦截器自动刷新 Token

```typescript
// 请求拦截：自动带上 accessToken
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 响应拦截：401 时自动刷新
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 401) {
      const refreshToken = await SecureStore.getItemAsync('refreshToken');
      const { data } = await api.post('/auth/refresh', { refreshToken });
      await SecureStore.setItemAsync('accessToken', data.accessToken);
      await SecureStore.setItemAsync('refreshToken', data.refreshToken);
      // 重试原请求
      error.config.headers.Authorization = `Bearer ${data.accessToken}`;
      return api(error.config);
    }
    return Promise.reject(error);
  }
);
```

### 3. 聊天连接

聊天不再需要 SDK 或独立 token：用 `accessToken` 直接握手同域的 socket.io 端点
`/chat-ws`。事件名、载荷与错误码见
[self-hosted-chat.md](self-hosted-chat.md)。

```typescript
import { io } from 'socket.io-client';

// 每次连接生成一个随机的连接追踪 ID(不含账号信息),同时放进 auth 和请求头:
// 请求头那份让 Caddy 的接入日志记下同一个 ID,auth 那份是网关侧的兜底来源。
// 两边都带上,握手失败时才能把代理层记录和网关记录对起来查;只发 auth.token
// 的老客户端仍可正常连接,只是排查时关联不上代理层那条。
// 格式必须匹配 ^ws-[a-zA-Z0-9-]{8,96}$,否则代理与网关都会忽略它。
const connectionTraceId = `ws-${crypto.randomUUID()}`;

const socket = io(API_BASE, {
  path: '/chat-ws',
  transports: ['websocket'],
  auth: { token: accessToken, traceId: connectionTraceId },
  extraHeaders: { 'x-connection-trace-id': connectionTraceId },
});
```

### 4. 设备名（会话管理）

注册/登录/刷新时携带设备名，方便在"登录设备"列表中识别：

```typescript
import * as Device from 'expo-device';

const headers = {
  'x-device-name': Device.deviceName ?? 'Unknown Device',
};
```
