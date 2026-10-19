# Circle 自建入口防护

2026-10-16。当前方案不接入 Cloudflare/腾讯云 WAF，不变更 DNS、不购买产品。

## 请求链路和预算

App → HTTPS/WSS Caddy → NestJS → PostgreSQL / Redis / 私有对象存储。

- Caddy 普通 API 入口每 IP 每分钟 600 次兜底；WebSocket Upgrade 单独每 IP 每分钟 60 次。多人共用 NAT 时需要监控 429 与合法重连情况，按证据调整，不能把数字当作压测承诺。
- NestJS HTTP 仍有每 IP 每分钟 300 次及登录等敏感路由专用限流。新增 Controller 路由默认需要 JWT，公开入口逐方法声明原因并由契约测试锁定。
- HTTP Controller 执行每进程最多 128 个并发，超出返回 503 和 Retry-After；不自动重试非幂等操作。鉴权阶段不属于这个 Controller 执行预算，前置入口限流仍不可移除。
- 两条 WebSocket 通道各自每进程最多 2000 条连接、128 条待认证连接，待认证 10 秒后终止。聊天账号还有跨实例连接上限和事件限流。该预算是资源保护，不代表实例实际能承载 4000 个活跃客户端；需根据主机和业务负载压测下调。
- Origin 白名单共享，拒绝未知浏览器来源；原生 App 无 Origin 仍需 JWT。Origin 不是原生客户端身份认证机制。

## 发布前端口检查

在部署主机、使用正式发布相同的全部 Compose 文件和环境变量执行：

```sh
set -o pipefail
docker compose -f docker-compose.prod.yml -f docker-compose.release.yml config --format json | node scripts/check-gateway-exposure.mjs
```

检查器只输出服务名和端口问题，不打印配置或凭据。其他主应用生产 override 也应合入同一次 config 后再检查。监控是独立 Compose 工程，应单独检查其最终配置：所有管理端口只绑定回环，不使用 host 网络。现有 cAdvisor 使用 privileged 宿主机采集权限，严格检查器会拒绝它；这需要发布时单独审查宿主机挂载与镜像，不能作为端口检查通过而忽略。允许公网发布的只有 Caddy 的 80/443；管理端口必须显式绑定 127.0.0.1 或 ::1，后端、数据库、Redis 使用 Docker 内网。CI 对发布合并配置执行此检查。

这证明部署声明，不证明线上实际监听状态。线上还需比对 `docker ps`、容器网络/端口、宿主机监听、云防火墙及从外网发起的探测，尤其避免其他 Compose 工程发布旧后端端口。不能通过在开发机器扫描 localhost 代替线上检查。

## 自建 WAF 与边界

当前 Caddy 限流和 NestJS 鉴权不是通用 WAF。若实际攻击与接口画像表明需要规则型 WAF，可在自己的服务器评估 Coraza/OWASP CRS 等成熟引擎；需先验证反代兼容、更新来源、JSON/媒体误报、资源开销和旁路模式，再逐接口启用。此轮不编写易误杀聊天内容的自制 SQL/XSS 正则，也不宣称已部署 WAF。

任何边缘 HTTP WAF 主要检查 WebSocket 握手，升级后的消息帧仍由 Gateway 检查。单台机器上的防护不能避免上游链路被超出带宽的攻击占满；若要求抵抗此类洪泛，需要上游网络/托管侧的流量清洗能力，或接受该可用性边界。

## 运维和验证

保留证书自动续期、应用安全更新、密钥轮换、数据库备份及恢复演练。告警关注入口 429、应用 503、待认证连接、鉴权失败、Redis 降级、CPU/内存和数据库连接池。日志中不得包含 Token、消息正文或签名媒体 URL。

生产 Caddy 镜像的语法与模块验证由现有 CI 和切流脚本执行。源站仍是单一入口；若以后在 Caddy 前加代理，必须同时更新可信代理与真实 IP 识别，只接受可信来源传入的转发头，并限制源站直连。

端到端加密另见 [设计方案](end-to-end-encryption-plan.md)，当前仍是服务端可读的聊天协议。

具体告警阈值、本地验证与服务器恢复后的执行顺序见 [发布检查单](gateway-release-checklist.md)。
