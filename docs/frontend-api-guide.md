# Frontend API Integration Guide

> Base URL: `http://localhost:3000`（开发环境）
> 所有请求和响应均为 `application/json`

---

## 目录

1. [认证机制](#认证机制)
2. [Auth 接口](#auth-接口)
3. [User 接口](#user-接口)
4. [Upload 接口](#upload-接口)
5. [错误处理](#错误处理)
6. [前端集成建议](#前端集成建议)

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
  "nickname": "Test User",       // 可选，1-30位，默认同username
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
