# 可观测性总览 —— 各工具检测什么数据

本项目的监控分**三条线**：

- **错误监控**（出了什么错 / 崩溃）→ Sentry
- **指标监控**（系统运行状态）→ Prometheus + Grafana + exporters
- **业务分析**（用户行为 / 转化）→ 待接（PostHog 等）

> 详细参考：[logging.md](./logging.md)（日志）· [metrics.md](./metrics.md)（指标）· [../monitoring/README.md](../monitoring/README.md)（监控栈）

---

## 速查表

| 工具              | 哪条线     | 检测 / 存储什么数据                         | 现状                      |
| ----------------- | ---------- | ------------------------------------------- | ------------------------- |
| **Sentry**        | 错误       | 异常、崩溃、堆栈、出错上下文                | 后端 ✅ 上线 · 前端待激活 |
| **Prometheus**    | 指标       | 时序指标的**存储 + 抓取**（存下面所有指标） | ✅ `:9090`                |
| 后端 `/metrics`   | 指标       | 接口 QPS/错误/延迟、业务事件、进程 CPU/内存 | ✅                        |
| **node-exporter** | 指标       | 机器：CPU / 内存 / 磁盘 / 网络 / 负载       | ✅（Mac 上 = Docker VM）  |
| **cAdvisor**      | 指标       | 每个容器：CPU / 内存 / 重启次数             | ✅                        |
| **Grafana**       | 指标(展示) | 不产数据，把 Prometheus 画成大盘            | ✅ `:3001`                |
| **Alertmanager**  | 指标(告警) | 不产数据，越界告警路由                      | ✅ `:9093`（飞书待接）    |
| OpenIM `/metrics` | 指标       | IM 在线连接数、消息吞吐                     | ⏳ 未接                   |
| **PostHog** 等    | 业务分析   | 用户行为、漏斗、留存、转化                  | ❌ 未做                   |

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

- 抓取目标：后端 `/metrics`、node-exporter、cAdvisor（OpenIM 待接）
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

连 Prometheus 做大盘。已自动 provision：Prometheus 数据源 + **「circle_be — RED」** 大盘（每路由请求速率 / 5xx 错误率 / p95 延迟 / 进程内存）。
入口 `:3001`（`admin` / `admin`）。

### 7. Alertmanager —— 告警路由（不产数据）

Prometheus 规则越界 → 发给它 → 去重 / 聚合 / 静默 / 路由。当前规则：5xx 率 > 5%、p95 > 1s、target down、主机内存 > 85%。出口：飞书 webhook（占位，需接一个转换器）。入口 `:9093`。

### 8. OpenIM `/metrics`（⏳ 未接）

IM 的**在线连接数、消息吞吐**——IM 核心负载。来自 OpenIM 自己（不是你后端）。需在 OpenIM config 开 metrics + 取消 `prometheus.yml` 里的注释 job。

### 9. 产品分析 / 业务埋点（❌ 未做）

用户行为事件、**漏斗、留存、转化**——给产品 / 增长。和 Prometheus 不同：**per-user**，不是聚合，Prometheus 存不了。推荐 PostHog（免费云起步）。这是独立的一套系统。

---

## 数据流向

```
错误线:
  前端 App ─┐
  后端     ─┴─► Sentry        (异常/崩溃 + 堆栈 + 上下文)

指标线:
  后端 /metrics ──┐
  node-exporter ──┼─► Prometheus ─┬─► Grafana       (大盘)
  cAdvisor      ──┘   (存 + 查)    └─► Alertmanager ─► 飞书(待接)
  (OpenIM 待接) ──┘

业务分析线(未做):
  前端/后端 ─────► PostHog 等   (漏斗/留存/转化)
```

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

|                                      | 地址                          | 登录          |
| ------------------------------------ | ----------------------------- | ------------- |
| Grafana（日常大盘）                  | http://localhost:3001         | admin / admin |
| Prometheus（原始查询 / target 健康） | http://localhost:9090         | —             |
| Alertmanager                         | http://localhost:9093         | —             |
| 后端原始指标                         | http://localhost:3000/metrics | —             |

启动监控栈：`docker compose -f monitoring/docker-compose.yml up -d`
停止：`docker compose -f monitoring/docker-compose.yml down`

> 看后端指标需后端在跑（`npm run start:dev`），否则 Prometheus 里 `circle-be` target 为 down。
