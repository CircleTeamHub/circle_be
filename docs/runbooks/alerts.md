# 告警处置手册

告警经 Alertmanager 发到 Discord，消息按 severity 分开：critical 10 秒聚合、每小时重提，warning 30 秒聚合、每 4 小时重提。告警里的 `runbook_url` 指向本页同名小节：`## 分组` 与规则文件里的 group 同名，`### 告警名` 就是 alertname。规则在 `monitoring/prometheus/alerts.yml` 与 `monitoring/loki/rules/fake/circle.yml`，阈值以规则文件为准，下文只是转述。

通用排查起点（三个 UI 只绑服务器回环：Grafana `3001`、Prometheus `9090`、Alertmanager `9093`，走 SSH 隧道）：

- Grafana 大盘，下文简称 RED / Jobs / Operations / Deliveries，依次是 `circle_be — RED`、`circle_be — Jobs, Queues & Datastores`、`circle_be — Operations Overview`、`circle_be — Deliveries, Dependencies & Business`。
- Prometheus：Alerts 页看表达式和当前值，Status → Target health 看抓取错误，Status → Rule health 看规则执行错误。Alertmanager：看当前告警、哪些被抑制、有没有静默。
- 日志：开了日志 overlay 时在 Grafana Explore → Loki 查（`circle-logs`、`circle-security-logs` 两组告警也只在那时存在，见 `monitoring/logs.md`）；否则用 `docker logs` / `docker compose logs`。
- 命令缩写，都在部署目录（仓库根）执行：`<应用栈>` = `docker compose -f docker-compose.prod.yml`；`<备份栈>` = `docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml`（叠了备份 overlay 的环境里动 postgres 一律用它）；`<监控栈>` = `docker compose -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml`；`<日志栈>` = `docker compose --env-file monitoring/.env -f monitoring/docker-compose.yml -f monitoring/docker-compose.prod.yml -f monitoring/docker-compose.logs.yml`；`<在役后端>` = `circle-be-blue` 或 `circle-be-green`，以 `.release/active-color` 为准。

抑制规则（`monitoring/alertmanager/alertmanager.yml`）会压掉上游故障必然引起的下游告警：`CircleBeNoTarget`、`PostgresDown` 在响时先处理它们；同名的 critical 会压掉 warning。`Watchdog` 永远 firing，只发给外部心跳服务、不进 Discord —— 外部服务**收不到**它才报警，那说明整机或监控栈本身挂了。背景见 `docs/observability.md`、`monitoring/README.md`、`docs/backups.md`、`DEPLOY.md`。新增告警时照现有格式，在对应分组下追加一个 `### 告警名` 小节。

## circle-be

### BackendHigh5xx

**含义**：（critical）近 5 分钟 5xx 占全部请求的比例超过 5%，持续 2 分钟。

**先看**：
- RED「5xx error ratio」和「Request rate by route」：是全站还是集中在几条路由；Prometheus 跑 `sum by (route, status_code) (rate(http_requests_total{status_code=~"5.."}[5m]))`。
- 后端 error 级的 `http_error` 事件：Loki `{service="circle-be", level="error"} | json | event="http_error"`，按 `path`、`errorName` 看；没开 Loki 用 `docker logs --since 15m <在役后端> 2>&1 | grep http_error`。

**常见原因与处置**：
- 数据库或连接池：`DbPoolExhausted` 同时在响时，请求是在 10 秒取连接超时后才变成 5xx，先处理池；`PostgresDown` 会把本条压掉。
- HTTP 并发预算打满时接口直接回 503（`GatewayCapacityRejecting` 会一起响），这类 5xx 的根因在容量那边。
- 刚发完版就开始：大概率是新版本回归，按 DEPLOY.md「回滚 / 重放」回到上一个 tag，再查原因。
- 后端整个不在时由 `CircleBeNoTarget` 报，本条被抑制。

### BackendHighLatencyP95

**含义**：（warning）全部路由合起来的 p95 延迟超过 1 秒，持续 5 分钟。

**先看**：
- RED「p95 latency by route (s)」：哪几条路由慢；低流量时少数慢请求就能把 p95 拉上去。
- 日志里的 `http_slow` 和 `database_operation_slow`（后者要 `PERFORMANCE_LOG_ON`）：`{service="circle-be", level=~"warn|error"} | json | event="database_operation_slow"`。

**常见原因与处置**：
- 连接池排队：`DbPoolQueueing` 通常更早响，按它处理。
- 事件循环被阻塞：看 `BackendEventLoopLag` 和 RED「Node event-loop lag p99 (s)」。
- 外部依赖慢：日志里的 `external_call_slow`（带 `service` / `operation`），对照 Deliveries 的依赖面板。
- 后端整个不在时被 `CircleBeNoTarget` 抑制。

### BackendEventLoopLag

**含义**：（warning）后端事件循环延迟 p99（`nodejs_eventloop_lag_p99_seconds`）超过 250ms，持续 5 分钟。请求可能还在返回 200，但进程已经在阻塞，通常比延迟和 5xx 告警更早出现。

**先看**：
- RED「Node event-loop lag p99 (s)」与「Backend process memory (bytes)」：是哪个实例，内存是否同时贴近上限。
- 同一时段 RED「p95 latency by route (s)」里突然变慢的路由，通常就是在主线程上做重活的那条。

**常见原因与处置**：
- 主线程上的同步重活（大 JSON 序列化、大批量处理）：定位到路由或任务后改代码，重启只能暂时缓解。
- 内存贴近 1g 上限导致 GC 频繁：看 `ContainerMemoryNearLimit`。
- 主机 CPU 被别的容器抢光：看 `HostCpuSaturated`。
- 后端整个不在时被 `CircleBeNoTarget` 抑制。

### UnhandledRejectionsOccurring

**含义**：（warning）过去 15 分钟里进程级兜底接住了至少一个没有 `.catch` 的 promise rejection（`circle_unhandled_rejections_total` 有新增）。进程不会死，5xx 和 TargetDown 都看不到它。没有 `for`，15 分钟内没有新增就自动消警。

**先看**：
- Deliveries「Unhandled rejections (15m)」看频率。
- 同一时刻的 `[unhandledRejection]` 日志行，带错误类型和 `at 文件:行:列` 栈帧：`{service="circle-be"} |= "[unhandledRejection]"`，或 `docker logs --since 30m <在役后端> 2>&1 | grep unhandledRejection`。

**常见原因与处置**：
- 代码里漏了 `await` / `.catch`：按栈帧找到调用点修代码，这是真 bug，不是噪音。
- 启动阶段 Redis / 数据库还没就绪时最容易漏，发版后紧跟着出现一条多半是这种。
- 同一签名在窗口内只记一行，`suppressedSinceLast` 是期间被省略的次数。

### TargetDown

**含义**：（critical）某个抓取目标 `up == 0` 持续 2 分钟，告警的 `job` 标签说明是哪一个。

**先看**：
- Prometheus Status → Target health 里该 job 的 lastError；Operations「Scrape targets up」。
- 对应容器在不在：`<监控栈> ps`、`<应用栈> ps`。

**常见原因与处置**：
- `circle-be` 报 `401 Unauthorized`：`METRICS_AUTH_TOKEN` 轮换过，跑 `bash monitoring/sync-metrics-token.sh`，再 `<监控栈> up -d --force-recreate prometheus`。
- `postgres-exporter` / `redis-exporter`：多半是 `monitoring/.env.exporters` 缺失或凭证过期，跑 `bash monitoring/sync-exporter-env.sh`，再 `<监控栈> up -d --force-recreate postgres-exporter redis-exporter`。
- 容器反复崩溃：看 `ContainerRestartLoop` 和该容器日志。蓝绿发版时退役颜色约 30 秒内消失，撑不满 2 分钟，不会因此报警。

### CircleBeNoTarget

**含义**：（critical）`up{job="circle-be"}` 这条序列整个不存在，持续 5 分钟 —— 一个在跑的后端容器都没有（蓝绿 DNS 发现返回零个目标，`TargetDown` 打不中这种情况）。

**先看**：
- `docker ps -a --filter name=circle-be-`：`circle-be-blue` / `circle-be-green` 是退出了还是根本不存在；对照 `.release/active-color` 和最近一次 Release workflow 的结果。
- 公网 API 探测是否也挂了：如果后端其实在跑、公网正常，问题在 Prometheus 这边（没接上 `circle-be_default` 网络，见 `monitoring/README.md`「Turning it on」第 1 步）。

**常见原因与处置**：
- 发版中途失败或容器被手动删掉：在 Actions → Release → Run workflow 重放当前 tag（DEPLOY.md「回滚 / 重放」），走正常蓝绿流程；不要在服务器上裸跑整栈 `up -d`，那会把停用的颜色也拉起来。
- 容器启动即退出：`docker logs --tail 200 circle-be-blue`（或 `circle-be-green`），常见是 `.env.production` 缺必填项，见 DEPLOY.md「排错」。
- 它在响时会压掉 5xx、延迟、事件循环、任务、队列、`BackendErrorLogSpike`、`SyntheticProbeFailing` 和 API 公网探测（`PublicEndpointDown{component="api"}`），恢复后留意这些是否接着冒出来。

### BackendVersionSkew

**含义**：（warning）`circle_build_info{job="circle-be"}` 同时出现两个以上不同的 version/commit，持续 30 分钟 —— 蓝绿两色跑着不同的构建。正常发版只在切换的几分钟里两色并存。

**先看**：
- Prometheus 跑 `circle_build_info{job="circle-be"}`：哪一色是哪个版本；对照 `.release/active-color`（Caddy 当前指向的颜色）和 `docker ps --filter name=circle-be-`。
- 最近一次 Release workflow 的日志：发版停在了哪一步（健康门禁、Caddy reload、烟测、停旧色）。

**常见原因与处置**：
- 发版脚本在「停/删旧色」之前被中断：确认 `.release/active-color` 指向的那一色健康、公网正常后，在 Actions 里重放当前 tag（DEPLOY.md「回滚 / 重放」）让流程走完；不要手动 `up -d` 整栈。
- 一色是 `unknown`：那台是本地构建或手动部署的镜像，`commit` 没写进去（只有 `build-image.yml` 传 `CIRCLE_BUILD_COMMIT`）；`version` 来自 env 文件的 `SENTRY_RELEASE`，手动部署时不会被发版脚本更新。

## reachability

### PublicEndpointDown

**含义**：（critical）blackbox 按用户路径（DNS → TLS → Caddy → 服务）探测某个公网入口，连续失败 2 分钟（30 秒探一次）。`instance` 是 URL，`component` 是 `api` 或 `admin`。

**先看**：
- 让 exporter 给出失败在哪一步：`<监控栈> exec prometheus wget -qO- 'http://blackbox-exporter:9115/probe?module=http_2xx&debug=true&target=<告警里的 instance>'`。
- Caddy 状态和日志：`<应用栈> ps caddy`、`<应用栈> logs --since 30m caddy`；Operations「Public probe success」。

**常见原因与处置**：
- DNS / TLS 失败：DNS 记录不再指向本机，或证书过期，对照 `TlsCertificateExpiryImminent`、`CaddyCertificateErrors`。
- Caddy 正常但上游挂了：`api` 探的是后端 `/healthz`（只认 HTTPS 下的 200），`admin` 探的是 admin_web 首页；后端整个不在时 API 这一路被 `CircleBeNoTarget` 抑制。
- 探测器和服务在同一台机器上，整机宕机时它也没了，那种情况只有外部心跳（`Watchdog`）能发现。
- `component="api"` 这一路在响时会压掉 `SyntheticProbeFailing`（同一条路径必然一起失败）。

### TlsCertificateExpiringSoon

**含义**：（warning）某个公网证书剩不到 14 天，持续 30 分钟。Caddy 在剩约 30 天时自动续期，这条响说明续期已经连续失败两周多。

**先看**：
- Operations「Public TLS certificate lifetime」看是哪个域名。
- Caddy 的 TLS 错误：Loki `{service="caddy", level="error"} | json | logger=~"tls.*"`，或 `<应用栈> logs --since 24h caddy` 里找 tls 相关行。

**常见原因与处置**：
- DNS 不再指向本机，或 80 端口被挡（ACME 验证要用，DEPLOY.md §2 两层都要放行），或撞上 ACME 限流。
- 修好根因后 Caddy 会按自己的退避重试；想立刻重试可以 `<应用栈> restart caddy`（会断流几秒，重启保留在役颜色的上游选择，见 `deploy/caddy-entrypoint.sh`）。
- 同一张证书剩不到 3 天时由 `TlsCertificateExpiryImminent` 接手，本条被压掉。

### TlsCertificateExpiryImminent

**含义**：（critical）某个公网证书剩不到 3 天，持续 10 分钟。再不处理客户端就会拒绝连接。

**先看**：
- 同 `TlsCertificateExpiringSoon`：Operations「Public TLS certificate lifetime」和 Caddy 的 TLS 错误日志。

**常见原因与处置**：
- 原因与 `TlsCertificateExpiringSoon` 相同（DNS、80 端口、ACME 限流），这时必须当天修好并确认续期成功。
- 它只压掉同一个 `instance` 的 `TlsCertificateExpiringSoon`，其他域名的 warning 照常报。

### PublicProbeNotConfigured

**含义**：（warning）blackbox-exporter 在跑，但 `blackbox-http` 一个探测目标都没有，持续 10 分钟 —— 上面几条公网告警永远不会响，看起来却像一切正常。

**先看**：
- 服务器上有没有 `monitoring/prometheus/probe-targets/public.yml`。

**常见原因与处置**：
- 漏配：`cp monitoring/prometheus/probe-targets/public.yml.example monitoring/prometheus/probe-targets/public.yml`，把两个示例域名换成 `.env` 里的 `API_DOMAIN` / `ADMIN_DOMAIN`，保留 `component` 标签。Prometheus 自己发现文件改动，不用重启。
- 发版后文件没了：旧版 launcher 的 rsync 会删 monitoring 下的本机配置，按 `docs/release-hardening-runbook.md` 升级 launcher 后再补回。

### SyntheticProbeFailing

**含义**：（critical）合成探测的测试号 15 分钟里没有一轮完整走通「刷新令牌 / 登录 → 拉会话列表 → 连 `/realtime` 拿到 `badge.snapshot`」（每 5 分钟一轮，至少连败 3 轮），持续 2 分钟。

**先看**：
- 哪一步、什么原因：Prometheus 跑 `sum by (step, reason) (increase(circle_synthetic_probe_failures_total[30m]))`；探测日志 `docker logs --since 30m circle-synthetic-probe`，每轮一行 `synthetic_probe_run`（不含令牌、账号和设备号）。
- 同一时间 `PublicEndpointDown`、`BackendHigh5xx`、`GatewayCapacityRejecting` 有没有在响：入口或后端整体故障时本条只是症状（API 入口、`CircleBeNoTarget`、`PostgresDown` 会压掉本条）。

**常见原因与处置**：
- `auth` 步：`login_rejected` 是登录被拒（密码被改了，或这个号不能走 App 登录，比如管理员账号）；`device_verification_required` 是探测设备被移出信任（登出所有设备、改密码、设备管理里删除），在测试号的受信任设备上批准，或按 docs/observability.md「只读合成探测」重新开通；`http_429` 是同一出口 IP 登录/刷新太频繁。
- `api` 步：`http_5xx` / `timeout` 看后端日志与连接池告警；`http_401` 会让下一轮自动刷新令牌，连续出现说明会话被吊销。
- `realtime` 步：`network` 是升级就被拒（Origin、容量 503、TLS），`ws_closed_1008` 是认证被拒或会话被吊销，`no_snapshot` 是连上了但服务端没推首帧，查后端 `realtime_*` 日志（同一 `traceId`）。
- 用户侧确实进不来时按对应的入口/后端告警处理；只有探测号自己的问题（密码、设备）时，修好后下一轮就会恢复。

### SyntheticProbeNotConfigured

**含义**：（warning）合成探测容器在跑，但 `.env.synthetic-probe` 缺项或不合法（`circle_synthetic_probe_configured == 0`），持续 1 小时 —— `SyntheticProbeFailing` 永远不会响。

**先看**：
- `docker logs circle-synthetic-probe`：启动时会打一行 `synthetic_probe_config_invalid`，列出缺失或不合法的变量名（不打印值）。

**常见原因与处置**：
- 还没开通：按 `.env.synthetic-probe.example` 在仓库根目录建 `.env.synthetic-probe`（chmod 600），步骤见 docs/observability.md「只读合成探测」，然后用监控栈启动时的同一组文件拉起：`<监控栈> up -d synthetic-probe`，开了日志 overlay 的机器用 `<日志栈> up -d synthetic-probe`。
- 暂时不打算用：`<监控栈> stop synthetic-probe`，容器不在时这条不会响。

## jobs

### CronJobStalled

**含义**：（warning）某个定时任务（`exported_job` 标签）距上次成功已超过 3 倍预期周期（下限 120 秒），持续 5 分钟。

**先看**：
- Jobs「任务心跳滞后（× 预期周期）」：红线 3.0 就是本告警阈值；是一个任务还是全部任务一起停。
- `sum by (result) (increase(circle_cron_runs_total{exported_job="<任务名>"}[30m]))`：`skipped` 在涨说明上一轮还没返回、新调度被重入闸挡回。
- 该任务的运行记录：`{service="circle-be"} | json | job="<任务名>"`（`job_run` 事件带 `runId` 和结果）。

**常见原因与处置**：
- 上一轮挂住（`skipped` 持续增加）：新进程能解开，在 Actions → Release 重放当前 tag 做一次蓝绿替换（零停机），再查是哪个调用没有超时。
- 任务每轮都失败：`CronJobFailing` 通常同时在响，按它处理。
- 数据库挂了或后端整个不在时，本条被 `PostgresDown` / `CircleBeNoTarget` 抑制。

### CronJobFailing

**含义**：（warning）某个定时任务最近一次运行的结果是失败（`circle_cron_last_result == 0`，包括任务自己 catch 住、用 `reportHandledJobFailure()` 上报的失败），持续 15 分钟。

**先看**：
- Jobs「最近一次运行失败的任务」「任务失败率（15m）」。
- 该任务的 warn / error 日志：`{service="circle-be", level=~"warn|error"} | json | job="<任务名>"`；开了 Sentry 时每次失败也会进 Sentry。

**常见原因与处置**：
- 依赖故障（数据库、Redis、推送通道）：先修依赖，任务会自己恢复。
- 代码 bug：按日志修代码。
- 只有下一次成功运行才会把结果翻回 1：每小时、每天跑一次的任务（如 `storage_audit`、`refresh_token_cleanup`、`push_stale_token_cleanup`）修好后要等到下一次调度才消警。
- 被 `PostgresDown` / `CircleBeNoTarget` 抑制。

### SessionRevocationOutboxStuck

**含义**：（critical）`session_revocation` 队列里最老的待处理行已超过 10 分钟，持续 5 分钟 —— 登出、封禁、盗号撤销没有生效。

**先看**：
- `RedisDown` 是否在响：撤销要写进 Redis 并广播到连接，最常见的 lastError 就是 `Redis revocation or socket broadcast unavailable`。
- 处理任务 `session_revocation_outbox` 是否有 `CronJobStalled` / `CronJobFailing`；日志里的 `Session revocation retry failed`。
- 管理台任务列表（后端 `GET /api/v1/admin/console/tasks?kind=session_revocation`）能看到每行的 attempts 和 lastError。

**常见原因与处置**：
- Redis 不可用：先恢复 Redis（见 `RedisDown`）。
- 失败行按指数退避重试，上限 1 小时，所以 Redis 恢复后积压不会立刻清空；队列排空之前这些撤销都还没落地。
- 被 `PostgresDown` / `CircleBeNoTarget` 抑制。

### OutboxBacklogStuck

**含义**：（warning）某个 outbox 队列（`queue` 标签）最老的待处理行超过 15 分钟，持续 10 分钟 —— 队列没有在排空。`gift_card` 稳态就有约 120 秒的滞留（2 分钟宽限期），不算异常。

**先看**：
- Jobs「最老待处理行的滞留时长」「队列积压（仍会重试）」。
- 消费这个队列的任务有没有停摆或失败。任务名多为「队列名_outbox」，例外：`chat_direct_auto_reply` → `chat_direct_auto_reply_jobs`，`chat_support_recharge` → `support_recharge_jobs`，`admin_group_operation`、`group_admission_delivery` 与队列同名。
- 管理台任务列表（`GET /api/v1/admin/console/tasks?kind=<队列>`）看 lastError，支持部分队列。

**常见原因与处置**：
- 下游不可用（推送通道、Redis、聊天写入）：每行都在失败重试，按 lastError 修下游。
- 处理任务挂住或没在跑：按 `CronJobStalled` 处理。
- 被 `PostgresDown` / `CircleBeNoTarget` 抑制。

### OutboxProbeStale

**含义**：（warning）某个队列的深度已超过 10 分钟没有读到新值，持续 5 分钟。这时它的积压和死信 gauge 是旧值，停在 0 也不代表健康。

**先看**：
- Jobs「队列读数新鲜度」：是一个队列还是全部。
- 日志里的 `Failed to probe outbox depth for <队列名>`（logger `OutboxDepth`，warn 级）。

**常见原因与处置**：
- 只有一个队列：那张表在迁移或被锁住，探测查询超时；锁释放后自动恢复。
- 全部队列一起：探测任务 `outbox_depth_probe` 停了（看 `CronJobStalled`），或数据库挂了（此时被 `PostgresDown` 抑制）。

### OutboxDeadLettersAppearing

**含义**：（warning）除 `gift_card` 外的某个队列过去 1 小时出现了新的死信（当前值高于这一小时的最低值），持续 5 分钟。死信是用尽重试、永远不会再处理的行。存量一小时不动后自动消警。

**先看**：
- Jobs「死信存量（永不重试）」「死信新增速率（1h）」看是哪个队列。
- 该队列处理器在同一时段的 error / warn 日志，以及管理台任务列表里的 lastError。

**常见原因与处置**：
- 会产生死信的队列：`notification_push`（TERMINAL）、`verification_card`、`chat_direct_auto_reply`、`chat_support_recharge`、`admin_group_operation`（FAILED，对应圈子会标成同步失败）、`group_admission_delivery`。
- 先修让它们失败的原因，再按业务影响决定是否人工补救；死信不会被自动重放。
- 刻意不被 `PostgresDown` 抑制：事故前刚出现的死信同样需要人看。

### GiftCardPermanentlyLost

**含义**：（critical）过去 1 小时有已结算的金币转账在 60 次补发后永久丢失了转账卡片，持续 5 分钟。钱已经划走，收款人拿不到任何凭证，需要人工对账。

**先看**：
- error 日志 `transfer card PERMANENTLY failed after 60 attempts gift=<id> ...`：`{service="circle-be"} |= "PERMANENTLY failed"`，或 `docker logs --since 2h <在役后端> 2>&1 | grep 'PERMANENTLY failed'`。
- 之前的 warn 日志 `transfer card compensation failed for gift <id>` 说明每次失败的原因。

**常见原因与处置**：
- 聊天写入或数据库长时间不可用：先修根因。
- 修好后重发卡片是安全的（`clientMessageId` 为 `gift_card_<id>`，幂等）：`<应用栈> exec postgres psql -U circle -d circle -c 'UPDATE "CoinGift" SET "cardAttempts" = 0 WHERE "cardDeliveredAt" IS NULL AND "cardAttempts" >= 60'`，补发任务 `gift_card_outbox` 下一分钟会重新投递。不要重新转账。
- 刻意不被 `PostgresDown` 抑制。

### WalletLedgerMismatch

**含义**：（critical）最近一次钱包对账（每天 05:00，`wallet_reconciliation` 任务）发现钱包余额不等于该用户全部流水金额之和（`check="ledger_mismatch"`），或出现负余额（`check="negative_balance"`）。读的是最近一次结果：进程重启不会让它消失，要等下一次对账的结果。

**先看**：
- 后端日志 `wallet_reconciliation_mismatch` 一行：只有计数，不含用户 ID。
- 在数据库里只读地列出有问题的钱包：

  ```sql
  WITH ledger AS (
    SELECT "userID", SUM("amount")::bigint AS total FROM "CoinTransaction" GROUP BY "userID"
  )
  SELECT COALESCE(w."userID", l."userID") AS user_id, w."balance", l.total
  FROM "Wallet" w FULL OUTER JOIN ledger l ON l."userID" = w."userID"
  WHERE COALESCE(w."balance", 0)::bigint <> COALESCE(l.total, 0) OR w."balance" < 0;
  ```

**常见原因与处置**：
- 代码里每一处改余额的地方都在同一个事务里写流水；对不上通常是有人直接改了库，或新加的扣款/入账路径漏写了流水。按 `CoinTransaction` 的 `type`、`relatedID` 和时间追到是哪一笔。
- 修正时余额和一条 `ADJUSTMENT` 流水放进同一个事务，不要只改 `Wallet.balance`（那只是把不一致挪个地方）。
- 修好后等下一次 05:00 的对账结果为 0 才消警；蓝绿换过色时，旧实例最后一次的结果最多再挂 26 小时。

## backups

### BackupCheckFailing

**含义**：（critical）备份每小时自检里的某一项（`check` 标签：`postgres_archive` / `backup_freshness` / `destination_bucket` / `minio_source`）连续两次失败（部署后第一次就失败时 5 分钟就响）。

**先看**：
- `<备份栈> logs --tail 200 backup` 里的 `FAIL` 行，它直接说明坏在哪一环。

**常见原因与处置**：
- `postgres_archive`：postgres 被不带备份 overlay 重建，WAL 归档关了（`<备份栈> exec postgres psql -U circle -d circle -c 'SHOW archive_mode'` 不是 `on`）。择时 `<备份栈> up -d` 恢复（会重启 Postgres），并按 `docs/backups.md` 在 `.env` 里固定 `COMPOSE_FILE`。归档停着时 `pg_wal` 会一直堆，留意磁盘告警。
- `destination_bucket` / `minio_source`：`.env.backup` 里的 `BACKUP_S3_*` / `BACKUP_MINIO_*` 被轮换或吊销。更新后 postgres 也要重启才能用上（它的 archive-push 读同一份凭证），择时进行。
- `backup_freshness`：48 小时没有完成的备份，按 `BackupNeverCompleted` 的办法手动跑一次全量。修好后 `<备份栈> run --rm backup run check` 立即刷新结果、消警。

### BackupCheckStale

**含义**：（warning）备份自检已超过 3 小时没有跑完（时间戳不再前进），持续 5 分钟。同一个容器还负责每天的全量/差异备份和对象镜像，它们大概率也没在跑。

**先看**：
- `<备份栈> ps backup` 看容器是否在跑；`<备份栈> logs --tail 200 backup` 看启动时的 `scheduling jobs:` 行和报错。

**常见原因与处置**：
- 容器退出：`BACKUP_JOBS` 里有镜像不认识的任务名时 entrypoint 直接退出（`unknown job in BACKUP_JOBS`），重建镜像后 `<备份栈> up -d backup`。
- `check.sh` 在写指标之前就退出（比如 `.env.backup` 缺变量），或写不进 metrics 卷（日志里有 `could not write backup metrics`）。
- 修好后 `<备份栈> run --rm backup run check` 立刻写出新时间戳。

### BackupCheckNotReporting

**含义**：（warning）生产环境（postgres-exporter 在跑）2 小时内没有任何备份自检结果 —— 备份 overlay 没部署，或者 `check.sh` 从没写出过指标。

**先看**：
- `<备份栈> ps backup backup-metrics` 两个服务是否存在并在跑；Prometheus Status → Target health 里的 `backup` job。

**常见原因与处置**：
- 备份 overlay 从没启用：按 `docs/backups.md`「Turning it on」启用。这条的意思就是「生产没有持续备份」，不要轻易静默。
- `backup-metrics` 在跑但没有数据：看 `backup` 日志里有没有 `could not write backup metrics`。

### BackupNeverCompleted

**含义**：（warning）自检一直在正常跑，但仓库里 30 小时都没有一份完成的备份（`backup_freshness` 这一项从未出现）。只有 WAL、没有基础备份时照样恢复不出来。

**先看**：
- `<备份栈> logs backup` 里凌晨 3 点前后（`BACKUP_CRON_PG_FULL` / `BACKUP_CRON_PG_DIFF` 默认时间）的全量 / 差异备份输出。
- 手动跑一次看报错：`<备份栈> run --rm backup run pg-full`。

**常见原因与处置**：
- 全量备份每次都失败（OOM、超时），而 WAL 归档和目标桶都正常，所以 `BackupCheckFailing` 不响；没有全量时差异备份会被升级成全量，同样失败。
- 修好后跑一次 `run pg-full`，再 `run check`，`backup_freshness` 出现后自动消警。

### ReleaseOffsiteBackupFailed

**含义**：（warning）最近一次发版时那份加密 `pg_dump` 没传到主机之外（`deploy/offsite-backup.sh`）。发版本身已完成，本地 dump 也在；这是持续备份之外的第二份异地副本。

**先看**：
- 服务器上 `cat ~/circle_be_backups/.offsite-status`（`failed <时间> <原因>`）；那次 Release run 日志里的 `OFF-HOST BACKUP UPLOAD FAILED` 横幅。
- Deliveries「Backups: last release off-host copy」。

**常见原因与处置**：
- 没填 age 公钥、主机没装 age、只写凭证缺失或失效、目标桶不可达，按 DEPLOY.md「异地备份」修。
- 下一次发版上传成功后自动消警。决定关掉发版异地备份或已手动补传时，这条结果不会被覆盖，要手动清掉：`<备份栈> exec backup rm -f /var/lib/circle-backup/metrics/release_offsite.prom`。

### BackupRestoreDrillFailing

**含义**：（critical）最近一次恢复演练（`deploy/backup/drill.sh`，调度器默认北京时间周三 03:30，`BACKUP_CRON_DRILL`）失败。`stage` 是停在哪一步：`preflight` / `live_counts` / `space` / `restore` / `start` / `query` / `compare`。

**先看**：
- `<备份栈> logs --since 24h backup | grep '\[drill\]'`：演练的完整输出，失败原因写在 `FATAL` / `WARN` 行。
- 修好后手动再跑一次确认：`<备份栈> run --rm backup run drill`（结果同样写进指标）。

**常见原因与处置**：
- `preflight`：演练拒绝接管 `DRILL_ROOT`（默认 `/tmp/drill`，在 `backup_scratch` 卷里）。可能是里面有不带演练标记的文件或 `PG_VERSION`，或者路径配成了 `/tmp` 这类太浅的目录，又或者锁文件放进了这个目录里，日志里的 `FATAL` 行写明了是哪一种。如果是旧版演练的残留，确认后手动删掉；否则先查清那是谁的数据。被杀掉的演练留下的副本（带 `.circle-restore-drill` 标记）下一轮会自动清掉，不会走到这里。
- `space`：`backup_scratch` 卷所在的盘放不下第二份数据库（要留 `DRILL_MIN_FREE_PERCENT`，默认 20%，高于 `HostDiskFilling` 的 15%）。先清盘或给备份 overlay 换一块盘，别为了让演练通过把余量调小 —— 演练会和线上库争同一块盘。
- `restore`：pgbackrest 拿不到仓库（凭证、目标桶、加密口令），通常 `BackupCheckFailing` 也在响，按它处理。
- `start` / `query`：恢复出来的集簇起不来或查不了，缺 WAL、配置不兼容，看日志里 scratch postgres 的输出。`start` 会等到 WAL 回放完（`DRILL_START_TIMEOUT`，默认 3600 秒），一周的 WAL 很多时可以调大。
- `compare`：恢复里少了表，一张有 `DRILL_EMPTY_TABLE_MIN_ROWS`（默认 1000）行以上的表恢复成了空表，或者日志里有 `BEHIND`（回放没追到演练开始时已归档的最新 WAL，归档里缺段）—— 这份备份不可信，当成真正的事故处理。

### BackupRestoreDrillStale

**含义**：（warning）超过 8 天没有一次恢复演练通过，持续 1 小时。演练在跑但一直失败时由 `BackupRestoreDrillFailing` 报，本条被它压掉；这条只剩「演练根本没在跑」。

**先看**：
- `<备份栈> logs backup | head -20`：调度器启动时打印的任务表里有没有 `drill`。
- `<备份栈> ps backup`：调度器是否在跑、镜像是不是 `circle-backup:2`。

**常见原因与处置**：
- `BACKUP_JOBS` 里没有 `drill`（本机改过 compose）或调度器没在跑：恢复配置后 `<备份栈> up -d backup`。
- 镜像还是旧版、不认识 `drill`：`<备份栈> build backup && <备份栈> up -d backup`。
- 日志里是 `another restore drill holds ... not starting a second one`：有一轮演练卡住了，看 `<备份栈> ps` 里有没有遗留的 `run --rm backup` 容器。

### BackupRestoreDrillNeverPassed

**含义**：（warning）备份自检一直在跑，但这台机器上从来没有一次恢复演练通过（`backup_metrics` 卷里没有演练成功的记录），持续 8 天。

**先看**：
- 同 `BackupRestoreDrillStale`：调度表里有没有 `drill`、镜像版本。

**常见原因与处置**：
- 新部署：手动跑一次 `<备份栈> run --rm backup run drill`，通过后这条就会消失，之后由调度器每周跑。
- 演练每次都失败时 `BackupRestoreDrillFailing` 会同时在响，按它处理。

## deliveries

### PushDeliveryFailing

**含义**：（warning）某个推送通道（`provider`：`expo` / `jpush`）近 15 分钟超过 20% 的投递失败（`retryable` + `rejected`），且 15 分钟内至少 20 次投递，持续 10 分钟。`dead_token`（卸载、注册 ID 失效）是正常流失，不计入。

**先看**：
- Deliveries「Push failure ratio by provider (15m)」「Push deliveries by provider and result」：是 `retryable` 还是 `rejected`。
- 日志里的 `external_call_failed`，看行里的 `service`（`expo_push` / `jpush`）和 `operation`：`{service="circle-be"} |= "external_call_failed"`。

**常见原因与处置**：
- JPush 没配或配错 `JPUSH_APP_KEY` / `JPUSH_MASTER_SECRET`：每次都记 `retryable`。
- Expo 侧的 APNs / FCM 凭证过期：同步 ticket 照样成功，失败只出现在回执阶段（`push_receipt_poll` 拉回执时计数）。
- 通道故障或配额：等恢复；`notification_push` 队列会重试，持续太久会接着出现 `OutboxBacklogStuck` / 死信。

### EmailCodeSendFailing

**含义**：（critical）近 15 分钟验证码邮件至少失败 3 封、且失败（`failure` + `unavailable`）超过一半，持续 5 分钟 —— 没人能用邮箱注册或验证码登录。

**先看**：
- Deliveries「Email code send failure ratio (15m)」「Verification-code emails by result」：是 `unavailable` 还是 `failure`。
- 日志里 `external_call_failed` 中 `service` 为 `smtp`、`operation` 为 `send_verification_code` 的行。

**常见原因与处置**：
- `unavailable`：生产根本没配 SMTP（`.env.production` 缺 `SMTP_HOST` 等），补上并让后端重启生效。
- `failure`：SMTP 认证（`SMTP_USER` / `SMTP_PASS`）、限流或服务商故障。中继型 SMTP 对错误收件人是事后退信，所以这里的失败基本是通道本身的问题，去服务商那边查。

### DependencyRequestsFailing

**含义**：（warning）后端直接调用的某个依赖（`dependency`：`object_storage` / `livekit`）近 15 分钟失败至少 5 次且超过 20%（不含 `HeadBucket` 探测、`not_found` 不算失败），持续 10 分钟。

**先看**：
- Deliveries「Dependency failure ratio (15m)」「Object storage requests by operation」；`sum by (dependency, operation) (increase(circle_dependency_requests_total{result="failure"}[15m]))` 看是哪个操作。
- 日志里 `external_call_failed`，`service` 为 `minio` 或 `livekit`。

**常见原因与处置**：
- `object_storage`：凭证还能 HeadBucket、但桶策略或权限拒掉服务端写入；凭证被轮换（`MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`）；存储所在磁盘满。存储整个连不上时由 `ObjectStoreUnreachable` 报，本条（仅 `object_storage`）被它抑制。
- `livekit`：`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` 配错或 LiveKit Cloud 故障，表现为通话建房失败。

## calls

### CallSetupFailing

**含义**：（warning）15 分钟内通话发起与接听的服务端失败（`circle_call_setups_total{result=~"livekit_unavailable|failed"}` 加 `circle_call_accepts_total{result="failed"}`）超过两成，且总量至少 5 次，持续 5 分钟。对方忙线、接听时通话已结束不算失败。

**先看**：
- `sum by (kind, result) (increase(circle_call_setups_total[30m]))` 和同样的 `circle_call_accepts_total`：是 `livekit_unavailable` 还是 `failed`，单聊还是群聊。
- `DependencyRequestsFailing{dependency="livekit"}` 有没有一起响；后端日志 `external_call_failed`（`service=livekit`）。

**常见原因与处置**：
- `livekit_unavailable`：`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` 没配或已失效，或者 LiveKit Cloud 本身故障（看它的状态页）。
- `failed`：服务端在建通话的事务里出错，按后端 error 日志和数据库告警排查。

### CallsEndingTooQuickly

**含义**：（warning）近 30 分钟接通的电话里，超过六成在 10 秒内就结束了（至少 5 通），持续 10 分钟 —— 信令走通了，双方却多半连不上媒体，只能挂断重拨。

**先看**：
- `sum by (kind) (increase(circle_call_answered_duration_seconds_bucket{le="10"}[30m]))` 对比 `..._count`：是单聊、群聊还是都有。
- 客户端的错误上报（Sentry）里 LiveKit 连接相关的错误；`circle_call_endings_total` 按 `reason` 看是谁结束的。

**常见原因与处置**：
- LiveKit 侧：凭证或项目被换、区域网络问题；签发的令牌指向的 `LIVEKIT_URL` 与客户端能连的地址不一致。
- 客户端版本：刚发的 App 版本里通话 SDK 或权限出了问题，对照发版时间。
- 低峰期少数几通测试电话也会触发（门槛只有 5 通），结合实际用户反馈判断。
- 它偏向抓「用户自己很快挂断」：客户端没调 `/leave` 就掉线、靠 LiveKit `room_finished` 结束的通话，时长要多算上 LiveKit 的离开超时（默认约 20 秒），不会落进 10 秒桶。掉线为主的故障更可能表现为用户反馈和 `circle_call_endings_total{reason="normal"}` 增多。

### LiveKitWebhookFailing

**含义**：（warning）15 分钟内有签名有效的 LiveKit 回调处理失败（返回 500，LiveKit 会重试）。`room_finished` 收不进来时，通话只能等双方各自挂断才结束。

**先看**：
- 后端日志 `call.webhook_failed`：事件类型、房间名和错误类型（不含请求体）。

**常见原因与处置**：
- 数据库故障或超时：按同时在响的数据库告警处理，恢复后 LiveKit 的重试会补上（结束通话是条件写入，重复处理无害）。
- 持续失败而数据库正常：是代码问题，按日志里的错误定位。

### LiveKitWebhookRejected

**含义**：（warning）30 分钟内至少 5 次回调签名校验失败，而且一次处理成功的都没有。

**先看**：
- LiveKit 控制台里 Webhook 配置的 URL 和它用哪一对 API key；后端 `.env.production` 的 `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`。验签用的就是这一对，`LIVEKIT_WEBHOOK_SECRET` 并不参与。

**常见原因与处置**：
- 轮换过 LiveKit 的 API key/secret 但后端没跟着改，或 Webhook 用的不是同一对 key：把 `.env.production` 改成一致后重启后端（DEPLOY.md「阶段 6 预告:LiveKit Cloud」的做法），或在 LiveKit 控制台把 Webhook 改回同一对 key。
- 有正常回调时的零星被拒是扫描器，那种情况本条不会响。

## meta

### AlertmanagerNotificationFailures

**含义**：（critical）过去 10 分钟 Alertmanager 有通知没发出去，持续 5 分钟。这条**不走 Discord**（坏的可能正是 Discord）：它被路由去 ping 外部心跳的 `/fail` 地址，同时抑制掉 `Watchdog`，所以你会从外部心跳服务那边收到告警。

**先看**：
- Operations「Alertmanager notification attempt failures (10m)」；`sum by (integration) (increase(alertmanager_notifications_failed_total[10m]))` 看是 Discord 还是 webhook。
- `<监控栈> logs --tail 200 alertmanager` 里的发送错误。

**常见原因与处置**：
- Discord webhook 被删或换了：更新 `monitoring/alertmanager/discord.url` 后 `<监控栈> restart alertmanager`。
- 心跳地址错了：检查 `heartbeat.url` / `heartbeat-fail.url`（后者必须以 `/fail` 结尾）。
- 主机出网或 DNS 故障、Discord 限流：恢复后自动消警，`Watchdog` 重新开始发，外部检查自己变绿。

### AlertmanagerConfigReloadFailed

**含义**：（critical）Alertmanager 拒绝了最近一次配置重载，持续 5 分钟。在跑的进程还在用上一份好的配置，但改动没生效。

**先看**：
- `<监控栈> logs --tail 100 alertmanager` 里的报错。
- 用 CI 同一条命令校验：`docker run --rm --entrypoint amtool -v "$PWD/monitoring/alertmanager:/cfg:ro" prom/alertmanager:v0.29.0 check-config /cfg/alertmanager.yml`。

**常见原因与处置**：
- 服务器上手改了 `alertmanager.yml` 并且有语法或引用错误：修到校验通过再重载。
- 校验通过之前**不要**重启或重建 Alertmanager：配置无效时它根本起不来，所有告警连同 `Watchdog` 一起中断。发版会经 `deploy/sync-ops-stacks.sh` 重建它，所以错配置也不能合进 main。

### PrometheusRuleEvaluationFailures

**含义**：（critical）过去 10 分钟 Prometheus 有规则求值失败，持续 5 分钟。求值失败的规则永远不会响，等于那条告警失效了。

**先看**：
- Prometheus Status → Rule health：哪条规则、什么错误；Operations「Prometheus rule evaluation errors (10m)」。
- `<监控栈> logs --tail 200 prometheus`。

**常见原因与处置**：
- 向量匹配出错（标签集变了、蓝绿两个实例报同一序列又没聚合）：改 `monitoring/prometheus/alerts.yml`，本地跑 CI 里的 `promtool check rules` 和 `promtool test rules` 后再合并。
- 负载太高导致查询超时：先看 `HighMemory` / `HostCpuSaturated`。
- 规则文件是单文件挂载，改完要重建 Prometheus 才生效（发版会自动做；手动是 `<监控栈> up -d --force-recreate prometheus`）。

### LogPipelineDroppedEntries

**含义**：（warning）过去 10 分钟 Alloy 永久丢弃了日志条目，持续 5 分钟。只在启用日志 overlay 时存在。

**先看**：
- Operations「Alloy log delivery retry and drop rates」；`<日志栈> logs --tail 100 alloy loki`。

**常见原因与处置**：
- Loki 拒收：条目太旧、乱序（重放旧文件时常见）或过大，见 `monitoring/logs.md`。
- 丢掉的只是 Loki 里的副本，源文件还在蓝 / 绿各自的日志卷里保留 14 天，需要时去那里查。不要把删 Alloy 的 offsets 当成例行排障手段。

### LogPipelineDeliveryStalled

**含义**：（warning）Alloy 向 Loki 推送日志已连续重试至少 15 分钟。Loki 和 Alloy 的抓取可能都还是健康的，但日志没进去，Alloy 的发送 WAL 在增长。

**先看**：
- Prometheus Status → Target health 里 `logs-pipeline` job 的 `component="loki"` 目标；`<日志栈> ps loki`、`<日志栈> logs --tail 100 alloy loki`。

**常见原因与处置**：
- Loki 挂了或反复重启（内存上限 512MB，对照 `ContainerRestartLoop` / `ContainerMemoryNearLimit`），或它的磁盘满了（对照 `HostDisk*`）。
- 推送恢复后自动消警。发送 WAL 只保留一小时，更久的中断会丢掉这段日志在 Loki 里的副本。

### LokiRulerNotificationsFailing

**含义**：（warning）过去 10 分钟 Loki 的 ruler 没能把日志告警发给 Alertmanager（发送错误或丢弃），持续 5 分钟。这期间 `circle-logs`、`circle-security-logs` 两组告警都发不出来。

**先看**：
- Alertmanager 是否还在内部 `logs` 网络上：最近有没有人只用两份监控 compose 文件 `up` 过它。
- `<日志栈> logs --tail 100 loki` 里的通知错误。

**常见原因与处置**：
- Alertmanager 被不带日志 overlay 重建，掉出了 `logs` 网络：`<日志栈> up -d --no-deps alertmanager` 把它接回去（`monitoring/logs.md` 第 4 步）。
- Alertmanager 本身挂了：先处理它，同时会看到别的告警也发不出。

### Watchdog

**含义**：（none）永远 firing 的心跳（`vector(1)`），只路由给外部心跳服务、每 5 分钟重发一次，不进 Discord。它在 firing 是正常状态。

**先看**：
- 只有外部心跳服务报「收不到心跳」时才需要处理：SSH 上主机，`<监控栈> ps`，`<监控栈> logs --tail 100 alertmanager prometheus`。

**常见原因与处置**：
- 整机宕机、断网、磁盘写满或监控栈被停：先恢复主机和监控栈，心跳自动恢复。
- `monitoring/alertmanager/heartbeat.url` 缺失或写错：Alertmanager 照常启动但 ping 不出去。
- `AlertmanagerNotificationFailures` 在响时会刻意压掉它，这时外部服务报的其实是「通知发不出去」。不要给它加 `for`、不要静默它、不要把它并进 Discord。

## capacity

### ChatAckLatencyP95

**含义**：（warning）自建聊天发送消息的 ACK 延迟 p95 超过 500ms，持续 5 分钟。

**先看**：
- RED「Chat send ACK p95 (s)」「Chat message send QPS」：是不是伴随发送量激增。
- Jobs「pg 连接池」和 RED「Node event-loop lag p99 (s)」。

**常见原因与处置**：
- 数据库慢或连接池排队：按 `DbPoolQueueing` / `PostgresConnectionsNearMax` 处理。
- 极热的单个群在刷屏：每个会话的消息序号用 advisory lock 串行分配，热群会排队（DEPLOY.md「规模上限备忘」）。这是有意的取舍，没有数据前不要动它。
- 事件循环阻塞：看 `BackendEventLoopLag`。

### ChatBroadcastLatencyP95

**含义**：（warning）自建聊天把消息交给 Socket.IO 广播的耗时 p95 超过 200ms，持续 5 分钟。

**先看**：
- RED「Chat broadcast p95 (s)」「Active chat connections」，以及「Node event-loop lag p99 (s)」。

**常见原因与处置**：
- 大群消息扇出到大量连接、连接数暴涨：对照连接数曲线确认是不是流量本身。
- 事件循环被阻塞或 CPU 不够：看 `BackendEventLoopLag`、`HostCpuSaturated`。

### GatewayCapacityNearLimit

**含义**：（warning）某个实例的某个进程内预算（`pool` 标签）用量超过 80%，持续 2 分钟。预算写在代码里：`http` 同时处理 128 个请求（`src/interceptors/http-capacity.interceptor.ts`），`chat_connections` / `realtime_connections` 各 2000 个连接、`chat_pending` / `realtime_pending` 各 128 个待认证连接（`src/chat/chat.gateway.ts`、`src/realtime/realtime.gateway.ts`）。

**先看**：
- Operations「Gateway budget utilisation」看是哪个 pool、哪个实例。按实例看，不要把蓝绿两个实例加起来。

**常见原因与处置**：
- `http` 占满：通常是处理器变慢、一直占着名额（数据库、外部依赖），先查 `DbPoolQueueing`、`BackendHighLatencyP95`。
- `*_connections` 占满：真实增长就要改代码里的上限并发版（同时确认内存余量）。
- `*_pending` 占满：大量连接不认证，看 `GatewayAuthTimeoutSpike`。

### GatewayCapacityRejecting

**含义**：（critical）某个实例的某个预算因为满了而拒绝请求或连接，近 5 分钟平均每秒超过 1 次，持续 2 分钟。HTTP 会收到 503（带 `Retry-After: 1`），WebSocket 连接被拒。

**先看**：
- Operations「Gateway capacity rejections and auth timeouts」「Gateway budget utilisation」；`BackendHigh5xx` 通常同时在响（503 算 5xx）。

**常见原因与处置**：
- 下游变慢把 `http` 名额占住：修数据库 / 依赖比放大预算更有效。
- 连接洪峰：区分真实增长和异常客户端（共用 NAT、客户端重连风暴、刷连接），对照 Caddy 的 `ws_proxy_access` 日志和 `GatewayAuthTimeoutSpike`。
- 阈值是初始运维值，不能单凭它认定是攻击（`docs/security/gateway-release-checklist.md`）。

### GatewayAuthTimeoutSpike

**含义**：（warning）连上来却没在 10 秒内完成认证、被超时关掉的连接，近 5 分钟平均每秒超过 5 次，持续 5 分钟。

**先看**：
- Operations「Gateway capacity rejections and auth timeouts」看是 `chat_pending` 还是 `realtime_pending`。
- 日志里 `realtime_auth_rejected` 的 `reason=auth_timeout`、`ws_auth_rejected`（按原因每分钟采样，`*_suppressed` 行带被省略的次数）。

**常见原因与处置**：
- 客户端回归：新版本连上后不发认证或发得太晚，看是否和 App 发版时间吻合。
- 只建连不认证的扫描或刷连接：会挤占 `*_pending` 预算，进一步引发 `GatewayCapacityRejecting`。
- 认证路径本身慢（会话校验依赖 Redis / 数据库）：看 `RedisDown`、`DbPoolQueueing`。

### ApiAuthFailureSpike

**含义**：（warning）后端 401/403 响应近 5 分钟平均每秒超过 10 次，持续 5 分钟。

**先看**：
- Operations「API authentication and rate-limit responses」；`sum by (route, status_code) (rate(http_requests_total{job="circle-be",status_code=~"401|403"}[5m]))` 看集中在哪些路由。
- 安全日志里的 `auth_unauthorized`（`metadata.authFailureReason`）和 `access_forbidden`。正常的过期令牌和不带令牌的 401 只算在这里、不进安全日志。

**常见原因与处置**：
- 客户端回归（刷新令牌坏了）：集中在少数路由、且和 App 发版时间吻合。
- JWT 配置变化：`InvalidTokenSpike` 会同时响，见那一条。
- 扫描或滥用，或大量合法用户共用一个出口 NAT：先区分清楚再动限流或封禁。

### ApiRateLimitSpike

**含义**：（warning）后端 429 响应近 5 分钟平均每秒超过 5 次，持续 5 分钟。

**先看**：
- Operations「API authentication and rate-limit responses」。
- `rate_limit_hit` 日志按 `limiterName` 和 `path` 看是哪个限流器：`{service="circle-be"} | json | event="rate_limit_hit"`。

**常见原因与处置**：
- 很多合法用户共用一个出口 NAT，撞上按 IP 的限流。
- 客户端重试风暴（失败后不退避地重试）：对照 App 发版时间。
- 滥用客户端：限流在按设计工作，确认后再决定要不要进一步处理；不要在弄清来源之前放宽限流。

### ChatAuthFailureSpike

**含义**：（warning）自建聊天握手认证失败近 5 分钟平均每秒超过 5 次，持续 5 分钟。

**先看**：
- `sum by (reason) (rate(chat_auth_failures_total[5m]))` 看失败原因分布。
- 日志 `ws_auth_rejected`（按原因每分钟采样，`ws_auth_rejected_suppressed` 带被省略的数量）。

**常见原因与处置**：
- `revoked`：一批会话刚被吊销（封禁、改密），客户端拿着死令牌反复重连，通常会自己降下来。
- `invalid_token` / `wrong_audience` / `invalid_claims`：客户端回归或 JWT 配置问题，对照 `InvalidTokenSpike`。
- `error` / `session_unverifiable`：服务端故障，看 `RedisDown` 和数据库。`guest_*` 是临时会话的访客连接。

### ChatRateLimitSpike

**含义**：（warning）自建聊天被限流的事件近 5 分钟平均每秒超过 5 次，持续 5 分钟。限流是每个 socket 的滑动窗口。

**先看**：
- RED「Chat rate-limited events (per second)」；`sum by (action) (rate(chat_messages_received_total{result="rate_limited"}[5m]))` 看是 `send` 还是 `typing` / `read` / `presence`。

**常见原因与处置**：
- 集中在 `typing` / `read` / `presence`：多半是客户端在循环发事件，对照 App 发版时间。
- 集中在 `send`：刷屏或机器人，限流在按设计工作，按账号处理。

### ContainerMemoryNearLimit

**含义**：（warning）某个容器（`name` 标签）的 working set 超过其内存上限的 90%，持续 5 分钟。没设上限的容器不在此列。

**先看**：
- `docker stats --no-stream` 看各容器实际占用；后端看 RED「Backend process memory (bytes)」的趋势。
- 是否已经在被 OOM 杀：看 `ContainerRestartLoop`。

**常见原因与处置**：
- 后端（`mem_limit: 1g`）内存持续上涨：疑似泄漏，看是从哪次发版开始；GC 压力会连带 `BackendEventLoopLag`。
- 正常负载增长：在对应 compose 文件里调高 `mem_limit` 并重建该服务（后端走发版），同时确认主机内存余量（`HighMemory`）。

### ContainerRestartLoop

**含义**：（warning）某个容器 15 分钟内重启了约 3 次以上（cAdvisor 按重启次数换新序列，数序列条数得出），没有 `for`。发版重建容器只算一次。

**先看**：
- `docker inspect --format '{{.RestartCount}} {{.State.OOMKilled}} {{.State.ExitCode}}' <容器名>`。
- `docker logs --tail 200 <容器名>` 看每次退出前打了什么。

**常见原因与处置**：
- `OOMKilled` 为 true：按 `ContainerMemoryNearLimit` 处理。
- 启动即崩：配置缺失（后端见 DEPLOY.md「排错」的「启动即退出」），或后端未捕获异常退出（`BackendFatalExit`）。
- 15 分钟内不再重启就自动消警；存活不到一个抓取间隔（15 秒）的那几次数不到，启动即崩的服务主要靠各自的 Down / `PublicEndpointDown` 兜底。

### HostCpuSaturated

**含义**：（warning）主机整体 CPU 使用率超过 90%，持续 10 分钟。

**先看**：
- 主机上 `docker stats --no-stream` 看哪个容器在吃 CPU；也可以在 Prometheus 里按 `name` 看 cAdvisor 的 `container_cpu_*` 系列（`docs/observability.md`）。

**常见原因与处置**：
- 消息洪峰或某个容器失控：对照聊天发送量和接口请求量。
- 主机上在构建镜像（首次 `--build`、发版后同步运维栈时构建备份镜像）：构建结束后自然回落。
- 持续打满会接着引发 `BackendEventLoopLag` 和延迟告警。

### HostDiskFilling

**含义**：（warning）某个可写的持久化文件系统（`mountpoint` 标签）剩余空间不到 15%，持续 10 分钟。

**先看**：
- 主机上 `df -h`、`docker system df -v`；Operations「Writable host filesystem used」看增长曲线。

**常见原因与处置**：
- 数据库：`pg_data` 增长，或 WAL 归档失败时 `pg_wal` 一直堆（对照 `BackupCheckFailing` 的 `postgres_archive`）。
- 对象存储：`note-exports/` 没有生命周期规则会无限增长，按 DEPLOY.md「存量环境补齐 note-exports 生命周期规则」补上。
- 日志与监控：后端日志卷按 14 天保留、没有总量上限；Loki 保留 7 天；Prometheus 上限 8GB。另外 `~/circle_be_backups/` 保留 7 份发版前 dump，恢复演练期间 `backup_scratch` 要占用约等于库大小的空间。旧镜像可以 `docker image prune -a --filter "until=720h"`（慎用）。
- 同一块盘剩不到 5% 时被 `HostDiskNearlyFull` 压掉。

### HostDiskNearlyFull

**含义**：（critical）某个可写的持久化文件系统剩余空间不到 5%，持续 5 分钟。只差一次日志风暴或一次大迁移：Postgres 写不进 WAL 会直接停库。

**先看**：
- `df -h`、`docker system df -v`，找出这块盘上增长最快的东西（候选见 `HostDiskFilling`）。

**常见原因与处置**：
- 立刻腾空间：清旧镜像、旧的本地 dump、已经不需要的演练残留。**不要**手工删 `pg_wal` 里的文件。
- WAL 归档失败导致的堆积，要先修归档（`BackupCheckFailing`），归档恢复后 Postgres 会自己清理。
- 它会压掉同一块盘的 `HostDiskFilling` 和 `HostDiskWillFillWithin24h`。

### HostDiskWillFillWithin24h

**含义**：（warning）按最近 6 小时的写入斜率，某块盘会在 24 小时内写满（只看剩余不到 40% 的盘），持续 1 小时。

**先看**：
- Operations「Writable host filesystem used」看是哪块盘、从什么时候开始变陡；隔一段时间跑两次 `docker system df -v` 对比，找增长最快的卷。

**常见原因与处置**：
- 日志暴涨：某个错误在刷屏（对照 `BackendErrorLogSpike`），或日志级别被临时调高后没改回 `LOG_LEVEL=info`。
- 某张表或 `note-exports/` 暴涨、WAL 归档失败导致 `pg_wal` 堆积。
- 斜率回落后自动消警；同一块盘剩不到 5% 时被 `HostDiskNearlyFull` 压掉。

### HostInodesLow

**含义**：（warning）某个文件系统剩余 inode 不到 10%，持续 10 分钟。inode 用完和磁盘写满一样，写不进任何新文件，但 `df -h` 看不出来。

**先看**：
- 主机上 `df -i`，确认是哪个挂载点。

**常见原因与处置**：
- 大量小文件：日志切片（后端日志每小时或每 20MB 切一次）、上传缓存、容器层。找到文件数最多的目录后清理或调整保留。
- 同一块盘不到 3% 时被 `HostInodesNearlyExhausted` 压掉。

### HostInodesNearlyExhausted

**含义**：（critical）某个文件系统剩余 inode 不到 3%，持续 5 分钟。日志、上传、WAL 这些新文件马上会创建失败。

**先看**：
- `df -i` 确认挂载点，再找文件数最多的目录。

**常见原因与处置**：
- 原因同 `HostInodesLow`，这时要立刻清理小文件，而不是等扩容。
- 它会压掉同一块盘的 `HostInodesLow`。

## datastores

### PostgresDown

**含义**：（critical）postgres-exporter 连不上数据库（`pg_up == 0`），持续 2 分钟。

**先看**：
- 后端自己怎么看：按 DEPLOY.md §5 在容器内查 `/readyz` 的 `database` 字段。后端说 `up` 而本条在响，问题在 exporter。
- `<应用栈> ps postgres`、`<应用栈> logs --tail 200 postgres`。

**常见原因与处置**：
- Postgres 挂了或被 OOM（`mem_limit: 1g`）、磁盘写满（对照 `HostDiskNearlyFull`）。叠了备份 overlay 的环境里重启它要用 `<备份栈>`，否则 WAL 归档会被静默关掉。
- exporter 凭证过期（轮换过 `DB_PASSWORD`）：`bash monitoring/sync-exporter-env.sh`，再 `<监控栈> up -d --force-recreate postgres-exporter`。
- 它会压掉任务、队列、5xx、`BackendErrorLogSpike` 和 `SyntheticProbeFailing`，所以一条假的 `PostgresDown` 会把真问题一起静音，要尽快核实。

### PostgresConnectionsNearMax

**含义**：（warning）Postgres 已用连接数超过 `max_connections` 的 80%，持续 5 分钟。

**先看**：
- Jobs「Postgres 连接数 / max_connections」「Postgres 后端连接（按状态）」。
- `<应用栈> exec postgres psql -U circle -d circle -c "SELECT state, application_name, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC"`。

**常见原因与处置**：
- 大量 `idle in transaction`：按 `PostgresIdleInTransaction` 处理。
- 连接预算本身不够：`DATABASE_POOL_MAX` × 实例数要低于 `max_connections`（默认 100），蓝绿发版期间两色同时在跑，按 2 倍算（`.env.production.example`）。
- 发版时两色同时在跑会短暂翻倍，切换完成后应自动回落。

### PostgresIdleInTransaction

**含义**：（warning）超过 5 个连接处于 `idle in transaction`，持续 10 分钟 —— 事务开着却不结束，一直占着连接名额。

**先看**：
- `<应用栈> exec postgres psql -U circle -d circle -c "SELECT pid, application_name, now() - xact_start AS xact_age, now() - state_change AS idle_for FROM pg_stat_activity WHERE state = 'idle in transaction' ORDER BY idle_for DESC"`。

**常见原因与处置**：
- 代码在事务里等外部调用、或异常路径没有结束事务：按出现时间对照日志和 `database_operation_slow` 找代码路径。
- 确认是泄漏的连接后可以 `SELECT pg_terminate_backend(<pid>)` 释放。
- 不处理会发展成 `PostgresConnectionsNearMax`。

### PostgresLongTransaction

**含义**：（warning）有一个 `active` 或 `idle in transaction` 的客户端事务已经开了 5 分钟以上，并且持续 5 分钟（postgres-exporter 自带的 `pg_stat_activity_max_tx_duration`）。autovacuum 不算。

**先看**：在库里查是谁：

```sql
SELECT pid, usename, application_name, state, now() - xact_start AS age,
       wait_event_type, wait_event, left(query, 120) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND xact_start IS NOT NULL
ORDER BY xact_start LIMIT 10;
```

**常见原因与处置**：
- 应用的交互式事务最长 30 秒，超过 5 分钟的基本不是正常请求：有人在 psql 里 `BEGIN` 了没提交，或某段代码在事务里等外部调用。
- 发版前的 `pg_dump` 和恢复演练的计数查询（`application_name` 为 `pg_dump` / `circle-restore-drill`）已排除在外。确认也不是正在跑的迁移（发版时 `migrate` 服务）后，可以 `SELECT pg_terminate_backend(<pid>)` 结束它；先记下 `query` 和 `application_name` 以便追原因。

### PostgresLockWaitStuck

**含义**：（warning）有会话在等锁，它所在的事务已经开了 60 秒以上，持续 2 分钟。`wait_event` 是锁的种类，`advisory` 是咨询锁（`auth_session` 这类按用户串行的锁）。

**先看**：谁挡着谁：

```sql
SELECT pid, pg_blocking_pids(pid) AS blocked_by, state, wait_event,
       now() - xact_start AS age, left(query, 120) AS query
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';
```

再用 `blocked_by` 里的 pid 查持锁那一方在干什么（上一条的查询加 `WHERE pid = <pid>`）。

**常见原因与处置**：
- 持锁的一方在事务里卡住（等外部调用、等客户端），本条常和 `PostgresLongTransaction` 一起出现；按上一条处理那个事务，等待的会话会自己继续。
- 咨询锁上的排队集中在某一个用户：多半是同一账号的大量并发请求（重试风暴），对照 `ApiRateLimitSpike`。

### PostgresLockPileUp

**含义**：（warning）同时在等锁的客户端会话不少于 5 个，持续 3 分钟。每个后端实例的连接池只有 10 个连接，排队的请求正在把它吃光。

**先看**：同 `PostgresLockWaitStuck` 的查询，看是不是同一个 `blocked_by`。

**常见原因与处置**：
- 一个持锁者挡住一串：处理那一个就能放开全部。
- `DbPoolQueueing` / `DbPoolExhausted` 很快会跟着响，那时 API 已经开始变慢或超时，优先处理。

### PostgresDeadlocks

**含义**：（warning）15 分钟内 Postgres 检测到死锁（`pg_stat_database_deadlocks` 增加）。Postgres 会中止其中一个事务，那个请求就失败了。

**先看**：`<应用栈> logs --since 30m postgres | grep -A5 'deadlock detected'`：日志里有互相等待的两条语句。

**常见原因与处置**：
- 两段代码以相反的顺序锁同一批行或咨询锁：按日志里的语句找到对应代码，统一加锁顺序。
- 偶发一次也说明有这条路径，值得开 issue；持续出现会表现为 5xx。

### PostgresXidWraparoundRisk

**含义**：（warning）某个库的事务 ID 年龄超过 5 亿（multixact 超过 8 亿），持续 1 小时。正常应在 `autovacuum_freeze_max_age`（默认 2 亿）附近；到 21 亿左右 Postgres 会拒绝写入。

**先看**：哪些表最老：

```sql
SELECT c.oid::regclass AS table, age(c.relfrozenxid) AS xid_age
FROM pg_class c WHERE c.relkind IN ('r', 'm', 't')
ORDER BY 2 DESC LIMIT 10;
```

**常见原因与处置**：
- 长事务或忘了提交的事务挡住了冻结：先处理 `PostgresLongTransaction`。
- 对最老的几张表手动 `VACUUM (FREEZE, VERBOSE) <表名>;`，在低峰期做；`template1` 这类库连上去对整库执行 `VACUUM FREEZE`。
- 有不再使用的复制槽（`SELECT * FROM pg_replication_slots`）也会挡住冻结。

### PostgresXidWraparoundImminent

**含义**：（critical）某个库的事务 ID 年龄超过 15 亿，持续 10 分钟。离 Postgres 拒绝写入只剩几亿个事务。

**先看**：同 `PostgresXidWraparoundRisk` 的查询。

**常见原因与处置**：
- 立即按上一条处理，先冻结最老的表；在冻结完成之前不要做大批量写入。它在响时会压掉同库的 `PostgresXidWraparoundRisk`。

### PostgresWraparoundMetricsMissing

**含义**：（warning）postgres-exporter 在跑（`pg_up == 1`），但没有导出回卷指标，持续 1 小时 —— 上面两条回卷告警永远不会响。

**先看**：`docker inspect circle-postgres-exporter --format '{{.Args}}'` 里有没有 `--collector.database_wraparound`。

**常见原因与处置**：
- exporter 还是按旧的 compose 参数在跑（运维栈没随发版重建）：`<监控栈> up -d --force-recreate postgres-exporter`。

### DbPoolQueueing

**含义**：（warning）后端进程内有请求在排队等 pg 连接（`circle_db_pool_waiting > 0`），持续 5 分钟。Postgres 那边看起来一切正常，瓶颈在应用的连接池。

**先看**：
- Jobs「pg 连接池」：waiting 和 total / idle / max 的关系。
- `{service="circle-be", level=~"warn|error"} | json | event="database_operation_slow"`（要 `PERFORMANCE_LOG_ON`）和 RED「p95 latency by route (s)」。

**常见原因与处置**：
- 少数慢查询长时间占着连接：修查询；单条语句上限是 `DATABASE_STATEMENT_TIMEOUT_MS`（默认 15 秒）。
- 流量上来而池只有 `DATABASE_POOL_MAX`（默认 10）：列表类接口一个请求就占两个连接。可以调大，但要守住 `max_connections` 预算（见 `PostgresConnectionsNearMax`）。
- 继续恶化就是 `DbPoolExhausted`。

### DbPoolExhausted

**含义**：（critical）某个实例排队等连接的请求数超过池容量（`circle_db_pool_max`）的一半，持续 2 分钟 —— 后续请求会撞上取连接超时（`DATABASE_POOL_ACQUIRE_TIMEOUT_MS`，默认 10 秒）变成 5xx。

**先看**：
- Jobs「pg 连接池」；`BackendHigh5xx` 是否已经在响。
- Postgres 那边有没有锁等待或长事务：`<应用栈> exec postgres psql -U circle -d circle -c "SELECT state, wait_event_type, count(*) FROM pg_stat_activity GROUP BY 1, 2"`。

**常见原因与处置**：
- 原因同 `DbPoolQueueing`，但已经在掉请求，要立刻找出占着连接的慢查询或长事务。
- 重放一次 Release 换新进程只能暂时清空池，根因不修会再来。
- 调大 `DATABASE_POOL_MAX` 前先确认 Postgres 不是本身就慢，否则只是把排队挪到数据库里。

### RedisExporterDown

**含义**：（critical）redis-exporter 连不上 Redis（`redis_up == 0`），持续 2 分钟。

**先看**：
- `RedisDown`（后端自己的视角）是否同时在响：两条都响 = Redis 本身挂了；只有本条 = exporter 的问题。
- `<监控栈> logs --tail 100 redis-exporter`。

**常见原因与处置**：
- Redis 挂了：按 `RedisDown` 处理。
- 轮换过 `REDIS_URL` / Redis 密码而 exporter 还在用旧凭证：`bash monitoring/sync-exporter-env.sh`，再 `<监控栈> up -d --force-recreate redis-exporter`。

### RedisMemoryNearLimit

**含义**：（critical）Redis 内存超过 `maxmemory` 的 90%，持续 5 分钟。内置 Redis 是 `noeviction`：撑到上限后写入直接报错，会话撤销也写不进去，等同于 `RedisDown` 的 fail-open。

**先看**：
- Jobs「Redis 内存占用率」看增长趋势。
- 内置 Redis：`<应用栈> exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info memory'`，再看 `info keyspace` 键数是否在涨。

**常见原因与处置**：
- 某类键没有过期时间在持续增长：按键前缀抽样找到来源后修代码。
- 正常增长：内置 Redis 的上限在 `docker-compose.prod.yml` 的 `--maxmemory 512mb`（容器 `mem_limit: 768m`），两个一起调大后重建 redis（短暂中断，AOF 保留数据）。托管 Redis 去服务商控制台扩容。

### RedisRejectingConnections

**含义**：（warning）过去 10 分钟 Redis 拒绝了新连接（达到 `maxclients`），持续 5 分钟。

**先看**：
- Jobs「Redis 客户端数」「Redis 被拒连接（10m 新增）」。
- 内置 Redis：`<应用栈> exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info clients'`。

**常见原因与处置**：
- 客户端数持续上涨不回落：应用侧连接泄漏，看是从哪次发版开始。
- 发版时两色同时在跑会短暂翻倍；不再有新的被拒连接后，10 分钟窗口滑过即消警。

### ObjectStoreUnreachable

**含义**：（critical）对象存储 HeadBucket 不通（`circle_object_store_up` 有实例为 0，30 秒缓存、2 秒超时），持续 5 分钟。所有用户发图、看图都会失败；`/readyz` 有意不因此变红。

**先看**：
- Deliveries「Object store reachable」。
- 内置 MinIO：`<应用栈> ps minio`、`<应用栈> logs --tail 200 minio`；后端日志里 `service` 为 `minio` 的 `external_call_failed`。

**常见原因与处置**：
- 内置 MinIO 挂了、被 OOM（`mem_limit: 1g`）或所在磁盘满（对照 `HostDisk*`）。
- 外部对象存储：凭证、端点（`MINIO_ENDPOINT` 等）或网络问题，去服务商那边确认。
- 它会压掉 `DependencyRequestsFailing{dependency="object_storage"}`。

## host

### HighMemory

**含义**：（critical）主机内存使用率超过 85%，持续 5 分钟。

**先看**：
- Operations「Host memory used」；主机上 `free -m` 和 `docker stats --no-stream` 看谁占得最多。

**常见原因与处置**：
- 各容器上限加起来超出主机：发版期间两色后端同时在跑（各 1g）会短暂抬高。
- 主机上在构建镜像，或备份容器在跑恢复演练（会起一个临时 postmaster）：结束后回落。
- 某个容器没设上限在失控增长：`ContainerMemoryNearLimit` 管不到它，靠 `docker stats` 找出来。

### ObjectStorePolicyUnconfirmed

**含义**：（critical）私有媒体的桶策略没能确认生效（`circle_object_store_policy_unconfirmed == 1`），持续 5 分钟 —— `notes/*` 可能可以匿名读取。`/readyz` 有意不因此变红，这条是唯一的叫醒机制。

**先看**：
- 存储是自管还是外部：`.env.production` 里的 `OBJECT_STORAGE_MANAGE_BUCKET`。
- 后端日志里的 `object_storage_bootstrap_failed`（带失败的步骤 `operation` 和服务商错误码）。

**常见原因与处置**：
- 外部对象存储（`OBJECT_STORAGE_MANAGE_BUCKET=false`，如腾讯 COS）：应用不管理也验证不了桶策略，指标恒为 1，这条会一直响。到服务商控制台核对 `notes/` 和 `chat/` 不能匿名读，核对后在 Alertmanager 里加一条写明原因和期限的静默。
- 自管 MinIO：生产上策略装不上时进程根本起不来（`OBJECT_STORAGE_POLICY_UNAVAILABLE`），所以生产上看到它多半是上一种情况；非生产环境是启动时 MinIO 不可达，恢复后下一次上传会重试，成功即消警。

### EmailCodeBypassActive

**含义**：（critical）固定验证码旁路在生效（`circle_email_code_bypass_active > 0`），持续 5 分钟 —— 允许名单里的账号不需要密码就能登录。

**先看**：
- 后端启动日志里的 `production_email_bypass_active` 事件；`circle_email_code_bypass_identities` 是名单条目数。
- `.env.production` 里的 `EMAIL_CODE_DEV_BYPASS`、`EMAIL_CODE_ALLOW_PRODUCTION_BYPASS`、`EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST`。

**常见原因与处置**：
- 预生产测试窗口结束后忘了关：按 `docs/pre-launch-checklist.md` 第 4 节把三个变量**整行删除**（不是设成空），保持文件权限不变，再让在役后端重新启动（重放一次当前 tag 的 Release 最稳），确认指标回到 0，并核对名单里出现过的都是测试账号。
- 值为 2：生产显式开了旁路但配置不合格、已 fail closed，旁路实际没生效，同样要把配置清掉。
- 本机开发环境设了 `EMAIL_CODE_DEV_BYPASS` 时它也是 1，开发机上可以忽略。

### RedisDown

**含义**：（critical）有在服务的后端实例 PING 不通 Redis（`circle_redis_up` 最小值为 0），持续 2 分钟。期间会话撤销（登出、封禁、盗号）静默 fail-open。

**先看**：
- `/readyz` 的 `redis` 字段（DEPLOY.md §5）；`RedisExporterDown` 是否同时在响。
- 内置 Redis：`<应用栈> ps redis`、`<应用栈> logs --tail 200 redis`；后端日志里 `service` 为 `redis`、`operation` 为 `connect` 的 `external_call_failed`。

**常见原因与处置**：
- Redis 容器挂了或被 OOM（`mem_limit: 768m`）：拉起来后撤销队列会按退避逐步补上（见 `SessionRevocationOutboxStuck`）。
- 轮换过 Redis 密码而 `.env.production` 的 `REDIS_URL` 没跟上（只有一个颜色坏时尤其要查它的配置），或托管 Redis 故障。
- 期间限流退化为单实例内存限流（DEPLOY.md §4），恢复后自动回到 Redis。

## circle-logs

### BackendFatalExit

**含义**：（warning）过去 10 分钟后端因未捕获异常退出过（日志里有 `[fatal] Uncaught exception` 那一行），没有 `for`，单次也报。容器会被自动拉起，指标上看不出来。

**先看**：
- `{service="circle-be"} |= "[fatal] Uncaught exception"`：行里带错误类型和 `at 文件:行:列` 栈帧；没开 Loki 用 `docker logs --since 30m <在役后端> 2>&1 | grep '\[fatal\]'`。
- 开了 Sentry 时同一个异常也会进 Sentry；`ContainerRestartLoop` 是否在响。

**常见原因与处置**：
- 代码在 promise 链之外抛了异常（事件回调、定时器）：按栈帧修代码，这是真 bug。
- 反复出现会表现为崩溃循环，期间请求会失败。没有新的 fatal 行，10 分钟后自动消警。

### BackendErrorLogSpike

**含义**：（warning）后端每 5 分钟写超过 50 行 error 级日志，持续 10 分钟。这是兜底告警，阈值按单机量级取，宁可迟报。

**先看**：
- 按事件分组看是哪一类：`sum by (event) (count_over_time({service="circle-be", level="error"} | json [5m]))`，再按 `component` 细分。

**常见原因与处置**：
- `http_error` 占大头：同 `BackendHigh5xx`。
- `external_call_failed` 占大头：某个依赖挂了，对照 `DependencyRequestsFailing`、`PushDeliveryFailing`、`RedisDown`。
- 被 `CircleBeNoTarget` / `PostgresDown` 抑制。

### CaddyProxyErrors

**含义**：（warning）Caddy 每 5 分钟有超过 10 行 error 级的反代 / 处理器错误（上游连不上、读写中断），持续 10 分钟。蓝绿切换的那一阵零星错误撑不满 `for`。

**先看**：
- `{service="caddy", level="error"} | json | logger=~"http\\.log\\.error.*|http\\.handlers\\.reverse_proxy"`，看 `msg`；请求 URI 已被脱敏，具体路由看后端自己的日志。没开 Loki 用 `<应用栈> logs --since 30m caddy`。

**常见原因与处置**：
- Caddy 有三个上游：后端在役颜色、MinIO（`/circle/*`）、admin_web。按时间对照 `CircleBeNoTarget`、`ObjectStoreUnreachable`、`<应用栈> ps admin_web`。
- 刻意不被 `CircleBeNoTarget` 抑制：它还覆盖 MinIO 和 admin_web，后端故障期间多一条 warning 是可接受的代价。

### CaddyCertificateErrors

**含义**：（warning）过去 30 分钟 Caddy 记录了 TLS 证书签发 / 续期错误，没有 `for`。比 `TlsCertificateExpiringSoon` 早得多，第一次续期失败时就能看到原因。

**先看**：
- `{service="caddy", level="error"} | json | logger=~"tls.*"` 的 `msg`；没开 Loki 用 `<应用栈> logs --since 1h caddy`。

**常见原因与处置**：
- DNS 没指向本机（`API_DOMAIN` / `ADMIN_DOMAIN`）、80 端口被挡（DEPLOY.md §2 两层都要放行）、ACME 限流。
- 偶发一次、Caddy 自己重试成功的，30 分钟后自动消警；反复出现就要在证书剩 14 天之前修好。

## circle-security-logs

### SecurityCodeGuessing

**含义**：（warning）每 5 分钟超过 20 次输错安全码或新设备验证码（`security_code_invalid` / `login_challenge_code_invalid`），持续 10 分钟。这两道码都在密码正确之后，持续成批输错像是有人拿到密码后在猜码。

**先看**：
- 按账号看是否集中：`sum by (userId) (count_over_time({service="circle-be"} |= "security_event" | json | securityEvent=~"security_code_invalid|login_challenge_code_invalid" [30m]))`；具体请求按 `requestId` 查。
- `SecurityCodeLockouts` 是否同时在响。

**常见原因与处置**：
- 集中在少数账号：这些账号的密码大概率已泄露，联系用户改密，必要时在管理台临时停用（会触发会话撤销）。
- 分散在很多账号：撞库，对照 `ApiRateLimitSpike` 和 `SecurityCodeLockouts`。日志按设计不记 IP。
- 客户端回归（提交过期的码）也会造成，但不会只集中在少数账号。

### SecurityCodeLockouts

**含义**：（warning）30 分钟内至少 3 个账号触发了安全码锁定（每次锁定 = 同一账号连续输错 5 次），没有 `for`。

**先看**：
- `{service="circle-be"} |= "security_event" | json | securityEvent="security_code_locked"` 看是哪些 `userId`。

**常见原因与处置**：
- 多个账号同时被锁更像撞库：锁定本身已经挡住了继续猜，按 `SecurityCodeGuessing` 处理这些账号（改密、必要时停用）。
- 30 分钟窗口内不再有新锁定就自动消警。

### RevokedSessionTokenReplay

**含义**：（warning）已吊销会话（全部登出、封号、改密）的令牌还在被使用：同一个会话 15 分钟内被用了 20 次以上，或 5 个以上不同用户的已吊销会话被重放。没有 `for`。

**先看**：
- `sum by (userId, metadata_sessionId) (count_over_time({service="circle-be"} |= "security_event" | json | securityEvent="session_revoked_token_used" [15m]))`：是一个会话在刷，还是很多用户。

**常见原因与处置**：
- 单个会话在刷：客户端登出后没清掉凭证（对照 App 版本），或令牌泄露后被重放。
- 很多用户：批量吊销之后（如一批封号）客户端还在用旧令牌，或成批的令牌泄露。
- 吊销本身是生效的（请求被拒），访问令牌到期（`JWT_EXPIRES_IN`，默认 1 小时）后也就不再出现；怀疑泄露时要追查来源，并让相关用户改密。

### InvalidTokenSpike

**含义**：（warning）每 5 分钟超过 50 个无效令牌（伪造、签名不对、audience / issuer 不对，即 `auth_unauthorized` 且 `metadata.authFailureReason=token_invalid`），持续 10 分钟。过期和缺失的令牌不在其中。

**先看**：
- `{service="circle-be"} |= "security_event" | json | securityEvent="auth_unauthorized" | metadata_authFailureReason="token_invalid"`，按 `path` 和时间分布看。
- 是否紧跟在一次发版或 `SECRET` 变更之后；`ApiAuthFailureSpike` 通常同时在响。

**常见原因与处置**：
- 换 JWT 签名密钥后客户端刷新一次就恢复，撑不满 `for`；持续出现说明实例之间签名配置不一致（同一个令牌在这台验得过、那台验不过），分别查两个颜色容器的日志，确认读的是同一份 `.env.production`。
- 客户端发错了令牌类型（如管理端令牌打到 App 接口，audience 不对）：集中在少数路径。
- 分散在各路径的伪造令牌：有人在试探，确认只是被拒绝即可，持续关注。
