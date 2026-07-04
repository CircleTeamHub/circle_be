# Admin Web 后续补充事项

本文记录 `circle_admin_web` 第一版之后仍需要补齐的安全、权限、审计、功能与部署事项。

## 当前基线

- Admin web 是独立 Vite/React 项目。
- 管理员和普通用户共用 `User` 表、密码哈希与基础 JWT 体系。
- Admin web 使用 `/auth/admin/login` 和 `/auth/admin/refresh`。
- 普通 App token 使用 `aud=APP`，后台 token 使用 `aud=ADMIN`。
- `AdminGuard` 同时校验 `role=ADMIN` 和 `audience=ADMIN`。
- Refresh token session 已增加 `audience` 字段，admin refresh 只接受 `ADMIN` session。
- Admin web 登录后仍会调用 `/auth/me`，要求 `role=ADMIN` 且 `status=ACTIVE`。
- Admin API 必须由后端 guard 校验，不能依赖前端页面隐藏。
- 本地 dev 可用 admin seed 创建 `admin@local.dev / Admin1234!`。

## P0：上线前必须补

### 1. Admin Web 外层访问控制

生产 `admin.<domain>` 必须至少启用一种外层保护：

- Cloudflare Access
- VPN
- IP allowlist
- Zero Trust SSO

要求：

- `admin.<domain>` 不裸露公网。
- Grafana/Sentry/Uptime Kuma/Alertmanager 不通过 admin web iframe 暴露。
- `api.<domain>` 可以给 App 使用，但 admin API 仍只信后端 admin token。

### 2. 管理操作审计表

第一版先写 business log，后续需要可查询审计表。

建议新增 `AdminAuditLog`：

- `id`
- `actorId`
- `actorAccountId`
- `action`
- `targetType`
- `targetId`
- `before`
- `after`
- `reason`
- `ip`
- `userAgent`
- `requestId`
- `createdAt`

需要覆盖：

- 用户封禁/解封/删除
- 举报审核通过/驳回
- 管理员登录/退出
- 权限变更
- 钱包/积分/余额调整
- 内容下架/恢复

### 3. Admin Session 策略

当前已区分 `APP` 与 `ADMIN` refresh session，但还需要更严格的时效策略：

- admin refresh TTL 更短，例如 8-24 小时。
- admin access token 更短，例如 5-15 分钟。
- 后台退出时撤销当前 admin session。
- 管理员被封禁/降权时撤销所有 session。

## P1：高优先级

### 1. 二次验证 / 2FA

建议给 ADMIN 增加至少一种二次验证：

- TOTP
- 邮箱验证码
- WebAuthn
- Cloudflare Access 的身份验证作为外层 2FA

高危操作可以要求 step-up verification：

- 封禁用户
- 删除用户
- 调整钱包
- 变更管理员权限

### 2. 管理员权限分级

不要长期只有 `ADMIN` 一个大权限。

建议扩展为：

- `SUPER_ADMIN`
- `MODERATOR`
- `SUPPORT`
- `OPS_READONLY`
- `FINANCE_ADMIN`

或使用 permission/scope：

- `reports:review`
- `users:ban`
- `users:delete`
- `wallet:adjust`
- `system:read`
- `audit:read`

### 3. 管理员账号生命周期

需要补：

- 创建管理员
- 禁用管理员
- 重置管理员密码
- 查看管理员列表
- 管理员权限变更审计
- 禁止最后一个 `SUPER_ADMIN` 被禁用

### 4. 更严格的 Rate Limit

Admin 登录和管理接口单独限流：

- 按 IP
- 按 account/email
- 按 Cloudflare Access identity
- 失败次数过多临时锁定

### 5. CSRF / CORS / Origin 策略

当前使用 Bearer token，CSRF 风险低于 cookie session，但仍要保证：

- `ALLOWED_ORIGINS` 明确包含 `https://admin.<domain>`。
- 不允许 `*`。
- admin API 可以额外检查 `Origin` 或 `Referer`。
- Nginx/Caddy 不把 admin API 暴露到错误域名。

## P2：功能补全

### 1. 举报系统扩展

当前第一版只接好友举报。

后续补：

- 群举报审核
- 圈子举报审核
- 笔记/动态/帖子举报审核
- 评论举报审核
- 举报合并与重复举报聚合
- 被举报对象历史记录

### 2. 内容治理

需要新增后台 API：

- 下架动态
- 恢复动态
- 删除评论
- 隐藏帖子
- 封禁圈子
- 恢复圈子
- 查看内容操作历史

### 3. 用户画像与风控

用户管理页后续补：

- 注册时间、最近登录 IP、设备信息
- 被举报次数
- 封禁历史
- 好友/群/圈子统计
- 钱包/积分摘要
- 最近操作摘要
- 风险标签

### 4. 钱包与积分管理

现有 `CoinService.adminTopUp` 后续可暴露 admin endpoint。

必须要求：

- 幂等键
- reason 必填
- 双人复核或 2FA
- 审计日志
- 操作前后余额记录

### 5. 运维只读视图

Admin web 只保留轻量状态，不替代运维系统。

可以补：

- Outbox 失败详情
- 最近失败原因
- 重试按钮，需权限控制
- API 健康状态
- 当前版本号 / build hash

深度图表仍跳转：

- Grafana
- Sentry
- Uptime Kuma
- Alertmanager

## P3：体验与工程优化

### 1. 前端拆包

当前 Ant Design bundle 偏大。

后续：

- React lazy routes
- manual chunks
- 页面级 code splitting

### 2. 表格体验

补：

- URL query 同步筛选状态
- 批量操作
- 导出 CSV
- 固定列
- 审核详情快捷键

### 3. 错误处理

补：

- 统一错误 toast
- 401/403/500 分层处理
- requestId 展示
- 操作失败可复制诊断信息

### 4. 测试补充

后续测试：

- admin refresh 短 TTL
- audit log 写入
- Cloudflare Access header 不作为后端授权依据
- 高危操作 reason 必填
- `SUPER_ADMIN` 自我保护

## 关键原则

- 前端权限只用于体验，后端 guard 才是安全边界。
- `role=ADMIN` 不等于可以调用所有后台接口，长期要拆权限。
- Admin token 必须和 App token 可区分。
- 所有高危操作必须有 reason、审计和可追溯 requestId。
- Admin 域名不能公网裸露。
