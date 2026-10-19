# 安全加固与监控发布准备

本批状态：本地候选，尚未部署。2026-10-16 用户确认腾讯云服务器未续费，当前只完成本地准备。恢复服务器后重新检查实际 IP、系统、数据卷、数据库、当前版本和凭据；旧服务器是否保留数据尚未确认。

## 本批范围

默认 HTTP 鉴权、公开入口白名单；聊天接入会话吊销竞态修复；两条实时通道共享 Origin 检查；连接、待认证和 HTTP 并发预算；Caddy 握手限流；端口暴露检查；保护指标与告警。

本批无数据库结构改动，不含其他未提交聊天功能。端到端加密仅有设计方案，尚未实现。源代码候选基于本地 HEAD；发布前必须与实际线上版本核对，不能因为本批无迁移就跳过基线中其他迁移检查。

## 告警与通知

沿用已有 Prometheus / Grafana / Alertmanager，生产 Discord webhook 保持原 `monitoring/alertmanager/discord.url`。该文件是凭据，不进仓库、发布包或日志；本地验证不得读取或复制为测试接收器。

| 告警 | 条件 | 等级 |
| --- | --- | --- |
| GatewayCapacityNearLimit | 单进程任一 HTTP / 连接 / 待认证预算使用超过 80%，持续 2 分钟 | warning |
| GatewayCapacityRejecting | 任一预算近 5 分钟平均拒绝超过 1 次/秒，持续 2 分钟 | critical |
| GatewayAuthTimeoutSpike | 待认证连接近 5 分钟平均超时超过 5 次/秒，持续 5 分钟 | warning |
| ApiAuthFailureSpike | NestJS 401/403 近 5 分钟平均超过 10 次/秒，持续 5 分钟 | warning |
| ApiRateLimitSpike | NestJS 429 近 5 分钟平均超过 5 次/秒，持续 5 分钟 | warning |
| ChatAuthFailureSpike | 聊天认证失败近 5 分钟平均超过 5 次/秒，持续 5 分钟 | warning |

现有服务不可用、5xx、延迟、CPU、内存、磁盘、数据库、Redis、证书过期、撤销队列积压、告警投递失败等规则继续使用。严重通知等待 10 秒、每小时重报；普通通知等待 30 秒、每 4 小时重报；两者均发送恢复通知。阈值是初始运维值，不能直接据此认定攻击；同时排查合法用户共用 NAT、客户端异常重试和实际容量不足。

Operations Overview 增加预算占用、拒绝/超时、API 401/403/429/503 面板。NestJS 指标无法统计提前被 Caddy 拒绝的请求；Caddy 握手记录保留现有脱敏策略，不能为补数据而记录 JWT、查询参数、消息内容或媒体签名 URL。

## 本地验证

- Jest 验证连接获取、认证、超时、释放、销毁、重复事件和 HTTP 异常/取消路径的资源与指标一致性，以及 `/metrics` 导出。
- `promtool check rules monitoring/prometheus/alerts.yml` 与 `promtool test rules monitoring/prometheus/alerts.test.yml` 验证规则语法、持续异常触发、正常流量不误报、多实例隔离和恢复。
- `amtool check-config monitoring/alertmanager/alertmanager.yml` 与 `amtool config routes test --config.file=monitoring/alertmanager/alertmanager.yml alertname=GatewayCapacityRejecting severity=critical` 验证实际路由。
- `ALERTMANAGER_BIN=/path/to/alertmanager python3 scripts/test-alert-delivery.py` 用本地临时 Alertmanager + 模拟 Discord 接收器验证告警与恢复投递，不向外部频道发送测试消息。使用生产固定的 Alertmanager 0.29.0。
- 隔离候选源代码构建与测试，确保未依赖其他未提交 Prisma/聊天功能；Docker 验证生产 Caddy 模块及合并 Compose 端口声明。

## 服务器恢复后的执行顺序

1. 核实目标、磁盘和数据卷是否保留；若已释放，先从备份恢复并验证数据完整性。确认当前版本、迁移状态、CPU/内存、Docker 网络、域名及 TLS。
2. 备份源代码、运行配置和数据库，保留旧镜像、Caddy 配置和切流状态。保护 `.env*`、Discord webhook、指标 token、heartbeat URL，禁止用本地文件覆盖。
3. 对候选版本执行正式 CI；按已有发布脚本构建、验证和切流。对合并 Compose 运行 `scripts/check-gateway-exposure.mjs`，公网只放行 Caddy 80/443，管理入口保留回环或受限 SSH。
4. 按 `monitoring/README.md` 同步指标 token、exporter 凭据，配置实际 API `/healthz` 与管理后台探测地址，启动生产监控 overlay。管理面板不公开。
5. 验证容器健康、内网 `/readyz`、外网 `/healthz`、受保护接口无 token 返回 401、登录入口可达，以及两个实时通道正常认证与重连。公网 `/metrics` 和 `/readyz` 保持隐藏。
6. 验证 Prometheus 抓取为 UP、新预算指标出现且上限正确、规则已载入、Alertmanager 路由无误；向现有 Discord 发送明确标注的测试告警并确认实际收到和恢复。仅无错误计数不能证明收件成功。
7. 同机监控无法在整机断网或被封堵时通知。核对已有外部 Watchdog 心跳是否仍在另一故障域运行；若没有，需要独立主机自建接收端或云侧告警，不能在同一服务器上完成这一覆盖。
8. 在腾讯云账户核对实际基础 DDoS 容量、清洗/封堵事件订阅及绑定收件人。这属于云账户配置；本地规则不等于已开通腾讯云告警。

## 回滚与验收边界

应用、Caddy、监控配置分别保留上一版本，先验证新容器再切流，失败即恢复旧入口。若实际基线差异含不可逆迁移，需要单独的数据库恢复方案，不能仅切回镜像。

当前未执行生产部署、腾讯云告警修改、真实 Discord 收件测试或外部心跳失联演练；这些在服务器恢复后验收。

## 已完成的本地验收（2026-10-16）

隔离候选基线 `b617a3935bd41c35f6d18d578d73485da0e2b241`，只覆盖本批清单中的文件。完整 Jest：314 套、4136 项通过，3 套/15 项原有跳过；`npm run build` 成功。46 条 Prometheus 规则语法与行为测试通过，Discord 严重/普通路由正确，本地模拟收到 2 条告警及 2 条恢复通知。Caddy 生产同款镜像构建、真实配置校验成功；主应用合并 Compose 端口检查成功，监控端口均为回环绑定。本机后端 `/readyz` 和 `/metrics` 返回 200、未登录受保护接口返回 401，五类容量指标与实际限制一致。

Linux/Node 22 生产后端镜像在本机 Docker 构建成功，使用原有 Dockerfile 和 lockfile。该本地镜像为本机 ARM64 验证产物；恢复发布时仍需按实际服务器架构通过正式 CI 构建，不直接上传为线上版本。
