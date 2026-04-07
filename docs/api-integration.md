# Circle Backend API 接入文档

## 基础信息

| 项目 | 值 |
|---|---|
| Base URL | `http://localhost:3000/api/v1` |
| 数据格式 | `application/json` |
| Swagger 文档 | `http://localhost:3000/docs` |
| 限流 | 每 IP 每分钟 300 次请求 |

## 统一响应格式

**所有接口**返回统一包装格式：

```json
{
  "code": 0,
  "message": "ok",
  "data": { ... }
}
```

---

## 认证机制

采用 **JWT Access Token + Refresh Token** 双 Token 方案。

- Access Token 有效期：**15 分钟**
- Refresh Token：长期有效，存入数据库，支持多设备
- 需要鉴权的接口统一在 Header 中传入：

```
Authorization: Bearer <access_token>
```

### Token 刷新流程

```
Access Token 过期 (401)
  → POST /auth/refresh { refreshToken }
  → 获取新的 accessToken + refreshToken
  → 用新 accessToken 重试请求
```

---

## 认证接口 `/api/v1/auth`

### 注册

```
POST /api/v1/auth/register
```

**Request Headers（可选）**
```
x-device-name: iPhone 15
```

**Request Body**
```json
{
  "username": "testuser",    // 4-20 字符，必填
  "password": "password123", // 6-64 字符，必填
  "nickname": "Test User"    // 1-30 字符，可选
}
```

**Response**
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "accessToken": "eyJhbGci...",
    "refreshToken": "uuid-string"
  }
}
```

---

### 登录

```
POST /api/v1/auth/login
```

**Request Body**
```json
{
  "username": "testuser",
  "password": "password123"
}
```

**Response** — 同注册，返回 `accessToken` + `refreshToken`

---

### 刷新 Token

```
POST /api/v1/auth/refresh
```

**Request Body**
```json
{
  "refreshToken": "uuid-string"
}
```

**Response** — 返回新的 `accessToken` + `refreshToken`

---

### 登出（当前设备）

```
POST /api/v1/auth/logout
```

**Request Body**
```json
{
  "refreshToken": "uuid-string"
}
```

---

### 登出所有设备

```
POST /api/v1/auth/logout-all
Authorization: Bearer <token>
```

---

### 获取当前用户信息

```
GET /api/v1/auth/me
Authorization: Bearer <token>
```

**Response**
```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "uuid",
    "accountId": "string",
    "username": "testuser",
    "nickname": "Test User",
    "avatarUrl": null,
    "status": "ACTIVE",
    "createdAt": "2026-04-05T00:00:00.000Z"
  }
}
```

---

### 查看登录会话列表

```
GET /api/v1/auth/sessions
Authorization: Bearer <token>
```

**Response**
```json
{
  "code": 0,
  "message": "ok",
  "data": [
    {
      "id": "uuid",
      "deviceName": "iPhone 15",
      "ip": "192.168.1.1",
      "userAgent": "Mozilla/5.0...",
      "createdAt": "...",
      "lastUsedAt": "...",
      "expiredAt": "..."
    }
  ]
}
```

---

## 用户接口 `/api/v1/user`

> 所有接口需要 `Authorization: Bearer <token>`

### 获取用户资料

```
GET /api/v1/user/profile?id=<userId>
```

### 获取用户详情

```
GET /api/v1/user/:id
```

### 更新用户信息

```
PATCH /api/v1/user/:id
```

**Request Body**
```json
{
  "nickname": "新昵称",
  "avatarUrl": "https://example.com/avatar.png"
}
```

### 删除用户

```
DELETE /api/v1/user/:id
```

---

### 管理员接口（需要 ADMIN 角色）

**获取用户列表**
```
GET /api/v1/user?page=1&limit=10&username=test
Authorization: Bearer <admin_token>
```

**创建用户**
```
POST /api/v1/user
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "username": "newuser",
  "password": "password123",
  "nickname": "New User"
}
```

---

## 错误处理

| HTTP 状态码 | 含义 |
|---|---|
| `400` | 请求参数错误（字段验证失败） |
| `401` | 未认证 / Token 过期 |
| `403` | 无权限（角色不足） |
| `404` | 资源不存在 |
| `429` | 请求频率超限 |
| `500` | 服务器内部错误 |

---

## 前端集成建议

1. **登录后**将 `accessToken` 存 `localStorage` / `sessionStorage`，`refreshToken` 存 `httpOnly cookie`（或 `localStorage`）
2. **每次请求**自动在 Header 注入 `Authorization: Bearer <accessToken>`
3. **拦截 401 响应**，自动调用 `/auth/refresh` 换新 Token 后重试
4. **注册/登录时**传 `x-device-name` Header 便于用户管理会话

---

> 完整交互式文档访问：`http://localhost:3000/docs`
