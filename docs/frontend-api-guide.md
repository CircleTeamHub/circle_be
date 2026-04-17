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
8. [错误处理](#错误处理)
9. [前端集成建议](#前端集成建议)

---

## 认证机制

### Token 说明

登录/注册成功后会返回三个 token：

| Token | 用途 | 有效期 |
|---|---|---|
| `accessToken` | 所有业务 API 请求的凭证 | 15 分钟 |
| `refreshToken` | `accessToken` 过期后用于换新 | 7 天 |
| `imToken` | 初始化 OpenIM SDK（即时通讯） | ~24 小时 |

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
  "refreshToken": "c8c1f46b2b9c...",
  "imToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

> `imToken` 为空字符串时，表示 OpenIM 服务未启动，跳过 SDK 初始化。

---

### 登录

```
POST /auth/login
```

**Request Body：**
```json
{
  "username": "testuser",
  "password": "password123"
}
```

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
  "refreshToken": "新的refreshToken（旧的立即失效）",
  "imToken": ""
}
```

> 注意：refresh 不返回新的 imToken，imToken 有效期较长无需频繁刷新。

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
  "accountId": "ACC_AB12CD",
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

> 软删除，status 变为 `DELETED`，只能删除自己（或 admin）

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
avatars   — 用户头像
covers    — 封面图（用户/Squad）
posts     — 帖子图片/视频
notes     — 笔记图片/视频
```

**Response 201：**
```json
{
  "uploadUrl": "http://localhost:9000/circle/avatars/uuid.jpg?X-Amz-Algorithm=...（5分钟内有效，视频30分钟）",
  "fileUrl": "http://localhost:9000/circle/avatars/uuid.jpg",
  "key": "avatars/uuid.jpg"
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
  "accountId": "ACC_AB12CD",
  "nickname": "张三",
  "avatarUrl": "http://10.0.0.195:9000/circle/avatars/xxx.jpg",
  "avatarFrame": null,
  "gender": "male",
  "lastOnline": "2026-04-09T10:00:00.000Z",
  "friendsSince": "2026-04-01T00:00:00.000Z"
}
```

#### FriendRequest 对象（申请条目）

```json
{
  "id": "uuid",
  "state": "PENDING",
  "createdAt": "2026-04-09T00:00:00.000Z",
  "message": "我是张三，加个好友吧",
  "user": {
    "id": "uuid",
    "accountId": "ACC_AB12CD",
    "nickname": "张三",
    "avatarUrl": "http://10.0.0.195:9000/circle/avatars/xxx.jpg"
  }
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

### 收到的好友申请

```
GET /friend/requests/incoming
```

**Response 200：** `FriendRequest[]`

---

### 发出的好友申请

```
GET /friend/requests/outgoing
```

**Response 200：** `FriendRequest[]`

---

### 好友动态列表

```
GET /friend/activities
```

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
    "accountId": "ACC_AB12CD",
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

用户 B 收到通知，查看申请列表
  → GET /friend/requests/incoming
  ← [{ id: "req_uuid", user: { ... } }]

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
      "url": "http://localhost:9000/circle/notes/user-1/file.mp4",
      "mimeType": "video/mp4",
      "size": 3456789,
      "durationMs": 12000,
      "posterUrl": "http://localhost:9000/circle/notes/user-1/file-cover.jpg",
      "sortOrder": 1
    }
  ]
}
```

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
await SecureStore.setItemAsync('imToken', imToken);
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

### 3. OpenIM SDK 初始化

```typescript
import { OpenIMSDK } from 'open-im-sdk-rn';

async function initIM(userID: string, imToken: string) {
  if (!imToken) return; // OpenIM 未启动时跳过

  await OpenIMSDK.initSDK({
    platformID: Platform.OS === 'ios' ? 1 : 2,
    apiAddr: 'http://localhost:10002',
    wsAddr: 'ws://localhost:10001',
    dataDir: '.',
    logLevel: 5,
    isLogStandardOutput: true,
  });

  await OpenIMSDK.login({ userID, token: imToken });
}
```

### 4. 设备名（会话管理）

注册/登录/刷新时携带设备名，方便在"登录设备"列表中识别：

```typescript
import * as Device from 'expo-device';

const headers = {
  'x-device-name': Device.deviceName ?? 'Unknown Device',
};
```
