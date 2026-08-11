# 可观测性总览 —— 各工具检测什么数据

本项目的监控分**三条线**：

- **错误监控**（出了什么错 / 崩溃）→ Sentry
- **指标监控**（系统运行状态）→ Prometheus + Grafana + exporters
- **业务分析**（用户行为 / 转化）→ 待接（PostHog 等）

> 详细参考：[logging.md](./logging.md)（日志）· [metrics.md](./metrics.md)（指标）· [../monitoring/README.md](../monitoring/README.md)（监控栈）

---

## 速查表

| 工具                | 哪条线     | 检测 / 存储什么数据                         | 现状                      |
| ------------------- | ---------- | ------------------------------------------- | ------------------------- |
| **Sentry**          | 错误       | 异常、崩溃、堆栈、出错上下文                | 后端 ✅ 上线 · 前端待激活 |
| **Prometheus**      | 指标       | 时序指标的**存储 + 抓取**（存下面所有指标） | ✅ `:9090`                |
| 后端 `/metrics`     | 指标       | 接口 QPS/错误/延迟、业务事件、进程 CPU/内存 | ✅                        |
| **node-exporter**   | 指标       | 机器：CPU / 内存 / 磁盘 / 网络 / 负载       | ✅（Mac 上 = Docker VM）  |
| **cAdvisor**        | 指标       | 每个容器：CPU / 内存 / 重启次数             | ✅                        |
| **Grafana**         | 指标(展示) | 不产数据，把 Prometheus 画成大盘            | ✅ `:3001`                |
| **Alertmanager**    | 指标(告警) | 不产数据，按 severity 分级路由 + 抑制       | ✅ `:9093` → Discord      |
| 自建聊天 `/metrics` | 指标       | 在线连接、聊天事件吞吐、ACK/广播延迟        | ✅                        |
| 定时任务/outbox     | 指标       | 任务心跳、失败率、队列积压、死信            | ✅（见下）                |
| **postgres-exporter** | 指标     | 连接数、事务、锁、idle-in-transaction       | ✅（仅生产 overlay）      |
| pg 连接池           | 指标       | 排队等连接数、已建立/空闲/上限              | ✅（应用内，见下）        |
| **redis-exporter**  | 指标       | 存活、内存占用、客户端数、被拒连接          | ✅（仅生产 overlay）      |
| **外部心跳**        | 元监控     | 监控栈自身是否还活着                        | ✅ Watchdog → 外部服务    |
| **PostHog** 等      | 业务分析   | 用户行为、漏斗、留存、转化                  | ❌ 未做                   |

---

## 逐个工具：检测什么数据

### 1. Sentry —— "哪里坏了 / 为什么"

抓**出错的瞬间**：异常、崩溃，附完整上下文，给工程师修 bug。

- **后端**（`LOG_AGGREGATION_PROVIDER=sentry` + `SENTRY_DSN` 时启用）：
  - 自动：未处理的 **5xx** 异常（`ErrorLoggingInterceptor`）
  - 每条带：错误 + 堆栈 + **脱敏**请求上下文（requestId / route / method / userId / status）；不带 body/header/token
- **前端**（`EXPO_PUBLIC_SENTRY_DSN` 时启用）：
  - 自动：JS 未捕获异常、未处理 Promise rejection、**原生崩溃**、React 渲染错误 + 面包屑
  - 带：设备型号 / OS / App 版本 / release
- **现状**：后端已上线 sentry.io 并验证；前端代码就绪，**待重建 App 激活**

### 2. Prometheus —— 指标的存储与抓取

时序数据库 + 抓取器。每 **15s** 从各 target 拉 `/metrics`，存成时间序列，供 PromQL 查询、Grafana 画图、Alertmanager 判断。**本身不产生数据**，是"存储 + 查询引擎"。

- 抓取目标：后端 `/metrics`、node-exporter、cAdvisor；生产还额外抓 postgres-exporter、redis-exporter
- 保留策略：15 天 / 8GB，先到者为准（`--storage.tsdb.retention.*`）
- 入口 `:9090`：**Status → Targets** 看抓取健康；**Graph** 跑 PromQL

### 3. 后端 `/metrics` —— 接口压力 + 业务 + 进程

| 指标                                            | 检测什么                                                  |
| ----------------------------------------------- | --------------------------------------------------------- |
| `http_requests_total{method,route,status_code}` | 每接口请求数 → **速率(Rate) + 错误(Errors)**              |
| `http_request_duration_seconds`                 | 延迟分布 → **p50/p95/p99 (Duration)**                     |
| `business_events_total{event,result}`           | 业务事件：登录 / 注册 / 好友操作…（按事件名 + 成功/失败） |
| `process_*` / `nodejs_*`                        | 后端进程 CPU / 内存 / 事件循环 / GC                       |

> 路由做了归一化（UUID/数字 → `:id`）防止基数爆炸。`/metrics` 默认无鉴权；设置 `METRICS_AUTH_TOKEN` 后要求 `Authorization: Bearer <token>`（`.env.production.example` 已内置该项）。鉴权只是第二层，生产环境**仍必须内网隔离/防火墙**。详见 [metrics.md](./metrics.md)。

### 4. node-exporter —— 机器压力

`node_cpu_*` / `node_memory_*` / `node_filesystem_*` / `node_network_*` / `node_load*`
→ 检测**主机**的 CPU、内存、磁盘、网络、负载。

> ⚠️ macOS 上测的是 **Docker Desktop 的 Linux VM**，不是 macOS 本身。真 Linux 服务器上才是主机。

### 5. cAdvisor —— 容器压力

`container_cpu_*` / `container_memory_*` / `container_network_*` / 重启次数
→ 检测**每个 Docker 容器**的资源占用和反复重启（重启=服务在崩）。

### 6. Grafana —— 可视化（不产数据）

连 Prometheus 做大盘。已自动 provision：Prometheus 数据源 + 两张大盘 ——
**「circle_be — RED」**（每路由请求速率 / 5xx 错误率 / p95 延迟 / 进程内存 / 聊天指标）
和 **「circle_be — Jobs, Queues & Datastores」**（任务心跳滞后与失败率、outbox 积压/死信、
pg 连接池排队、Postgres 连接与状态、Redis 内存与被拒连接）。
入口 `:3001`，密码取自 `monitoring/.env`（**没有默认值**，且只在数据卷首次启动时生效 —— 见 monitoring/README.md 的首启动坑）。

### 7. Alertmanager —— 告警路由（不产数据）

Prometheus 规则越界 → 发给它 → 去重 / 聚合 / 静默 / 路由。共 30 条规则，覆盖
接口 RED、聊天容量、主机与容器、定时任务与 outbox、连接池与数据存储。

出口按 severity 分级：`critical` → Discord（10s 聚合 / 1h 重提），`warning` → Discord
（30s / 4h），`Watchdog` → **外部**心跳服务。另有 3 条抑制规则，避免一次故障被报成
五种叫法（详见 monitoring/README.md「Alert tiers and inhibition」）。入口 `:9093`。

### 8. 自建聊天指标

自建 Socket.IO 网关会把连接数、实例在线用户数、消息事件吞吐、ACK
延迟、广播延迟、连接拒绝和限流事件合并到后端 `/metrics`。关键指标包括：

- `chat_connections_active`：当前连接数，多实例可以求和。
- `chat_users_online`：当前实例去重后的用户数，多实例不能直接求和。
- `chat_messages_received_total`：发送/已读/正在输入/在线查询事件速率。
- `chat_message_ack_duration_seconds`：消息处理 ACK 延迟。
- `chat_broadcast_duration_seconds`：交给 Socket.IO 广播的耗时。

这些指标不带 userId、conversationId、socketId 标签，避免 Prometheus
高基数。OpenIM scrape job 已从监控配置移除。

### 9. 定时任务与 outbox —— 「什么都没发生」这类故障

这一组补的是此前**完全没有信号**的盲区。理解它之前先看清两件事：

- Sentry 的 `captureError` 只在 `ErrorLoggingInterceptor` 里被调用，也就是**只覆盖
  HTTP 5xx**。定时任务抛出的异常还能被 `@sentry/node` 的进程级集成兜住，但——
- 4 个 outbox 处理器都**自己 catch 异常**、写进行上的 `lastError` 然后继续。异常
  永远不逃出去：Sentry 收不到事件，RED 大盘一切正常。队列堵死时没有任何人会知道。

`notification-push-outbox` 甚至专门设计了 `TERMINAL` 死信状态，注释写着「让积压
对运维可见」—— 在此之前没有任何东西在看它。

| 指标                                          | 检测什么                                            |
| --------------------------------------------- | --------------------------------------------------- |
| `circle_cron_runs_total{job,result}`          | 任务在跑但一直报错                                  |
| `circle_cron_last_success_timestamp_seconds{job}` | 任务**根本没在跑**（进程活着、调度器停了）      |
| `circle_cron_interval_seconds{job}`           | 该任务的预期周期，供告警算 `3 × 周期` 的阈值        |
| `circle_cron_last_duration_seconds{job}`      | 单次耗时（是否越来越慢、是否会与下一轮重叠）        |
| `circle_outbox_pending{queue}`                | 仍会被重试的积压量                                  |
| `circle_outbox_oldest_age_seconds{queue}`     | 最老一条待处理行的滞留时长 —— 队列到底有没有在排空  |
| `circle_outbox_dead{queue}`                   | 已放弃、不会再重试的行（死信）                      |

四个队列：`session_revocation`、`notification_push`、`friend_chat_replay`、
`gift_card`（`CoinGift` 上的虚拟队列）。

两个关键设计，改动前务必先读懂：

1. **心跳在装饰期就播种成进程启动时刻**，不是等第一次成功。否则首次成功前序列
   不存在，`time() - metric > 阈值` 求值为空，一个从开机起就没跑过的任务反而
   永远不告警 —— 和 `up` 序列消失导致 `up == 0` 打不中、需要 `absent()` 兜底
   是同一个坑。
2. **队列深度不在 `/metrics` 的 `collect()` 里查库**，而是由
   `OutboxDepthService`（自身也是 `@TrackedCron`）每分钟刷新，gauge 只报最近
   一次读数。抓取时查库的话，数据库慢或挂掉会让整个 `/metrics` 卡到 scrape
   超时 —— 恰好在数据库事故期间，把 RED、事件循环、chat 延迟一并弄丢。

新增定时任务请用 `@TrackedCron(表达式, '任务名')` 而不是裸 `@Cron`；
`src/metrics/tracked-cron.coverage.spec.ts` 会在 CI 上把漏用、重名、以及表达式
未登记周期这三种疏漏钉住。

### 10. 连接池 —— postgres-exporter 看不见的那一面

| 指标                      | 检测什么                                       |
| ------------------------- | ---------------------------------------------- |
| `circle_db_pool_waiting`  | **正在排队等连接的请求数** —— 池耗尽的确定信号 |
| `circle_db_pool_total`    | 已建立的连接数（含空闲）                       |
| `circle_db_pool_idle`     | 空闲连接数                                     |
| `circle_db_pool_max`      | 配置上限（`DATABASE_POOL_MAX`，默认 10）       |

池排队发生在 **Node 进程内部**：从 Postgres 视角连接数没涨、没有慢查询、没有锁
等待，一切正常；而应用侧请求已经在 `connectionTimeoutMillis`（10s）上排队，超时
后才变成 5xx。等 `BackendHighLatencyP95` 响的时候早就晚了。这是 postgres-exporter
在原理上就看不到的一类故障。

之所以能拿到精确数字而不是估算：本项目用 `@prisma/adapter-pg`，底下是真正的
node-postgres `Pool`，`waitingCount` 就是这个读数。`PrismaService` 自己创建这个池
再交给适配器，为的就是留住引用（因此也承担了关闭责任，见 `onModuleDestroy`）。

> **不要去找 Prisma 自带的 `$metrics`。** 它在 Prisma 7 已被移除，
> `previewFeatures = ["metrics"]` 会直接报 P1012 —— 那条路是死的。

### 11. 元监控 —— 监控自己死了怎么办

整套监控栈和被监控对象在**同一台机器**上。机器宕机、磁盘写满、网络断开时，
Prometheus / Alertmanager / Uptime-Kuma 一起没了，Discord 一条消息都不会有 ——
而 `HostDiskFilling`、`HighMemory` 这些恰恰是「真触发时离整机不可用不远了」的
告警。

`Watchdog` 规则永远 firing，被 Alertmanager 单独路由到一个**外部**心跳服务
（healthchecks.io 等）。方向和其他所有告警相反：外部服务**收不到**心跳才报警。
配置见 [../monitoring/README.md](../monitoring/README.md) 的「外部心跳」一节。

### 12. 产品分析 / 业务埋点（❌ 未做）

用户行为事件、**漏斗、留存、转化**——给产品 / 增长。和 Prometheus 不同：**per-user**，不是聚合，Prometheus 存不了。推荐 PostHog（免费云起步）。这是独立的一套系统。

---

## 数据流向

```
错误线:
  前端 App ─┐
  后端     ─┴─► Sentry        (异常/崩溃 + 堆栈 + 上下文;后端每次发版带 release)

指标线:
  后端 /metrics ─────┐   (RED + 业务 + 聊天 + 定时任务/outbox + 基建状态)
  node-exporter ─────┤
  cAdvisor      ─────┼─► Prometheus ─┬─► Grafana       (大盘)
  postgres-exporter ─┤   (存 + 查)    └─► Alertmanager ─┬─► Discord (warning, 4h)
  redis-exporter ────┘                                  ├─► Discord (critical, 1h)
                                                        └─► 外部心跳服务 (Watchdog)

业务分析线(未做):
  前端/后端 ─────► PostHog 等   (漏斗/留存/转化)
```

> Alertmanager 侧还配了抑制规则：`CircleBeNoTarget` / `PostgresDown` firing 时
> 压掉它们必然引发的下游告警（5xx、延迟、事件循环、任务停摆、队列积压），
> 一次故障不再刷五种叫法。同一 `alertname` 的 critical 也会压掉它的 warning。

---

## 三条线 vs 三类人

| 线       | 看什么                        | 给谁        | 工具                 | 数据形态            |
| -------- | ----------------------------- | ----------- | -------------------- | ------------------- |
| 错误监控 | bug / 崩溃                    | 工程        | Sentry               | 单个错误事件 + 堆栈 |
| 指标监控 | 系统健康（RED / 机器 / 容器） | 运维        | Prometheus + Grafana | 聚合数字（时序）    |
| 业务分析 | 用户行为 / 转化               | 产品 / 增长 | PostHog 等           | per-user 事件       |

> "都叫埋点"但完全不同：**指标埋点**进 Prometheus（聚合），**业务埋点**进 PostHog（per-user 漏斗）。

---

## 访问入口

|                                      | 地址                          | 登录                       |
| ------------------------------------ | ----------------------------- | -------------------------- |
| Grafana（日常大盘）                  | http://localhost:3001         | `monitoring/.env` 中的密码 |
| Prometheus（原始查询 / target 健康） | http://localhost:9090         | —                          |
| Alertmanager                         | http://localhost:9093         | —                          |
| 后端原始指标                         | http://localhost:3000/metrics | —                          |

启动监控栈：`docker compose -f monitoring/docker-compose.yml up -d`
停止：`docker compose -f monitoring/docker-compose.yml down`

> 看后端指标需后端在跑（`npm run start:dev`），否则 Prometheus 里 `circle-be` target 为 down。
