# circle_be 跑多个后端实例：核对清单与方案

> 核对对象：`origin/main` 的 `fac5daa7`（2026-11-24）。只读核对 + 本机验证，没有碰测试服。
> 本文分两半：第 1–5 节是核对结论，第 6–9 节是已经实现的部分、还没做的部分、上线前
> 必须由人确认的事项和容量推算。

## 0. 结论

- **代码基本已经按多实例写好了。** 33 个 `@TrackedCron` 定时任务里没有「两个实例同时
  跑会出事」的；实时通道的广播、踢下线、在线状态都走 Redis；App、访客网页只用
  WebSocket 传输，不需要会话粘滞。
- **真正挡着的是部署编排**（容器名写死、Caddy 单上游、日志卷每色一个）。这一块已经
  实现：`.env` 里 `CIRCLE_BE_REPLICAS=1..4`，默认 1；默认时发版脚本执行的命令、Caddy
  适配出的配置与改动前逐字节一致（见 6.3）。
- **本机用真实镜像起了 N=2 并验证通过**：两个实例各连一批连接，A 实例上的人发消息，
  B 实例上的人 26ms 内收到；经 Caddy 的 12 条连接 6/6 摊在两个实例上；停掉一个实例
  期间经 Caddy 的 60 个请求全部正常（见 6.4）。
- **上线多实例之前有 8 件事要人确认或补做**（第 8 节），其中两件是硬前置：
  `@Throttle` 限流是每实例一份；`REDIS_REQUIRED=true` 时本机启动必失败（启动探测抢在
  Redis 连接就绪之前，见 8.2）。
- **测试服（2 核、库同机）不要开多实例**：两个核已经被一个后端进程（70%）和
  PostgreSQL（51%）用满，加实例只会互相抢。正式服建议 4 核 8G 起步、N=2（见第 9 节）。

## 1. 定时任务（33 个 `@TrackedCron`）

`@TrackedCron` 就是 `@nestjs/schedule` 的 `@Cron` 加记账
（`src/metrics/tracked-cron.decorator.ts`），每个进程各自触发，两个实例会在同一秒跑同
一个任务。分类：

- **A 已有跨进程互斥**：原子认领（条件 `updateMany` / 租约列）、`pg_advisory_*`、
  `FOR UPDATE [SKIP LOCKED]`、Redis 任务租约。进程内的 `if (this.running) return`
  不算。
- **B 无互斥，重复执行无害**：幂等删除、只读探测。
- **C 重复执行有害**。
- **D 拿不准**。

结果：**A 27 个、B 6 个、C 0 个、D 0 个。** 涉及资金的四个（7、19、27、28）都不会
重复加减余额。

| # | 任务 | 位置 | 周期 | 类 | 依据 |
|---|---|---|---|---|---|
| 1 | `assistant_alert_delivery` | `src/assistant/assistant-alert-delivery.processor.ts:37` | 1 分钟 | A | 条件 `updateMany` 认领 + `leaseToken`（`:71-84`）；消息以 dedupeKey 幂等，重放不重发 |
| 2 | `outbox_depth_probe` | `src/metrics/outbox-depth.service.ts:264` | 1 分钟 | B | 只有 aggregate/count（`:207,213`），写的是进程内 gauge |
| 3 | `note_status_fanout_outbox` | `src/note/note-status-fanout-outbox.processor.ts:62` | 1 秒 | A | generation + status 条件认领 + `leaseToken`（`:87-100`）；提醒有 alertKey 幂等键。见下方备注 ① |
| 4 | `note_share_link_cleanup` | `src/note/note-share-link.cleanup.ts:26` | 每天 4 点 | B | 单条 `deleteMany`（`:33-37`），第二个进程删 0 行、不抛错 |
| 5 | `like_reconciliation` | `src/like/like-reconciliation.service.ts:30` | 每天 4 点 | A | `pg_try_advisory_xact_lock`，拿不到直接返回（`:38-41`） |
| 6 | `friend_chat_replay_outbox` | `src/friend/friend-chat-replay-outbox.processor.ts:47` | 1 分钟 | A | 条件认领 + `leaseToken`（`:70-78`）；回放消息有确定性 clientMessageId |
| 7 | `referral_reward_sweep` | `src/referral/referral.service.ts:123` | 1 小时 | A | **资金**：Serializable 事务内逐行 `FOR UPDATE` + PENDING 复核（`:238-251`）；状态落 REWARDED 与两笔入账同事务，入账带唯一幂等键 `referral:inviter:{id}` / `referral:invitee:{id}` |
| 8 | `note_cleanup` | `src/note/note-cleanup.ts:44` | 10 分钟 | A | 标记用条件 UPDATE（`src/note/note.service.ts:6154-6171`），删行用 `FOR UPDATE` 复核（`src/note/note-purge.ts:36-48`）；输的一方不记失败 |
| 9 | `fancy_number_lease_sweep` | `src/fancy-number/fancy-number.cleanup.ts:10` | 1 分钟 | A | Serializable + `endedAt: null` 条件 UPDATE（`src/fancy-number/fancy-number.service.ts:1150-1187`），广播只发一次 |
| 10 | `temp_chat_cleanup` | `src/temp-chat/temp-chat.cleanup.ts:33` | 1 分钟 | A | 逐房间 `pg_advisory_xact_lock` + `cleanupCompletedAt` 复核（`src/temp-chat/temp-chat.service.ts:621-646`） |
| 11 | `circle_plaza_post_sweep` | `src/circle-plaza/circle-plaza.cleanup.ts:25` | 1 分钟 | A | 整任务 `pg_advisory_xact_lock`，取批与标 ENDED 同事务（`src/circle-plaza/circle-plaza.service.ts:1355-1375`） |
| 12 | `chat_media_retention` | `src/chat/chat-media-retention.service.ts:63` | 每天 5 点 | A | Redis 任务租约 `runWithJobLease`（`:71`）；删对象另有逐 key advisory 锁认领（`src/chat/chat-media.service.ts:617-661`） |
| 13 | `chat_circle_sync` | `src/chat/chat-circle-sync.service.ts:185` | 1 分钟 | A | `runWithJobLease`（`:191`）+ 逐圈子 advisory 锁后重算差集（`:513`）。见备注 ② |
| 14 | `chat_burn_sweeper` | `src/chat/chat-burn-sweeper.service.ts:64` | 1 分钟 | A | `runWithJobLease`（`:74`）；兜底是 `deleted=false` 条件 `updateManyAndReturn`，只广播本次真烧掉的行（`:207-224`） |
| 15 | `session_revocation_outbox` | `src/admin-user/session-revocation-outbox.processor.ts:25` | 1 分钟 | A | 以 nextAttemptAt + attempts 做 CAS 认领（`:49-60`）；撤销本身幂等 |
| 16 | `chat_burn_archive_cleanup` | `src/chat/chat-burn-archive-cleanup.service.ts:77` | 1 分钟 | A | `runWithJobLease`（`:79`）；兜底为会话行锁后重读 |
| 17 | `chat_direct_auto_reply_jobs` | `src/chat/chat-direct-auto-reply.processor.ts:89` | 1 分钟 | A | 条件 `updateMany` 认领（`:198-207`）；回复按 clientMessageId 查重并同事务标完成 |
| 18 | `chat_direct_auto_reply_cleanup` | `src/chat/chat-direct-auto-reply.processor.ts:135` | 每天 4 点 | B | 分批 `deleteMany`，行被对方删掉时影响 0 行 |
| 19 | `support_recharge_jobs` | `src/chat/chat-support-recharge.processor.ts:128` | 1 分钟 | A | **资金相关**：只推进充值申请单状态、不发放；`updateMany PENDING→PROCESSING` 逐条认领（`:159-163`） |
| 20 | `refresh_token_cleanup` | `src/auth/refresh-token.cleanup.ts:51` | 10 分钟 | A | `runWithJobLease`（`:59`）；租约失效时也只是幂等 `deleteMany` |
| 21 | `notification_push_outbox` | `src/notification/notification-push-outbox.processor.ts:51` | 1 分钟 | A | 逐条 `updateMany` 认领 + `leaseToken`（`:100-119`），推送只在认领成功后发 |
| 22 | `push_receipt_poll` | `src/notification/notification-push.service.ts:754` | 5 分钟 | B | 状态迁移都带 `status: 'SENT'` 守卫，第二个进程影响 0 行。对 Expo 的回执查询量 ×N（只读） |
| 23 | `push_stale_token_cleanup` | `src/notification/notification-push.service.ts:1002` | 10 分钟 | A | 每批事务内 `pg_try_advisory_xact_lock`（`:1025`），拿不到记 skipped |
| 24 | `access_revocation_outbox` | `src/auth/refresh-token.service.ts:516` | 1 分钟 | B | 会话半段有 `leaseToken` 认领（`:361-386`）；scope 半段无认领，但重复广播只是再关一次已命中的连接 |
| 25 | `notification_retention_cleanup` | `src/notification/notification-retention.cleanup.ts:52` | 30 分钟 | A | 删除语句自带 `FOR UPDATE SKIP LOCKED`（`:71-81`、`:108-118`） |
| 26 | `call_ringing_sweep` | `src/call/call.cleanup.ts:16` | 1 分钟 | A | `RINGING→MISSED` / `INVITED→MISSED` 条件写（`src/call/call.service.ts:2056-2066`、`:1491-1500`），只有赢家删房间、广播、落通话记录 |
| 27 | `wallet_reconciliation` | `src/coin/wallet-reconciliation.service.ts:45` | 每天 5 点 | B | **资金**：零写入。只读事务，没有结果表，结果只进 gauge 和日志；`WalletLedgerMismatch` 按 `max by (check)` 聚合，不重复告警 |
| 28 | `gift_card_outbox` | `src/coin/gift-card-outbox.processor.ts:36` | 1 分钟 | A | **资金**：钱已在送礼时结算，本任务只补发卡片；`cardAttempts` 比较并自增抢占（`:54-62`）+ `gift_card_<id>` 幂等键 |
| 29 | `console_event_retention` | `src/admin-console/console-insights.service.ts:393` | 每天 4 点 | A | `runWithJobLease`（`:397`）+ `SKIP LOCKED` |
| 30 | `circle_consent_invitation_delivery` | `src/circle-invitation/circle-invitation.service.ts:499` | 1 分钟 | A | 逐条 `pg_advisory_xact_lock` + `consentNoticeClaimedAt` 2 分钟租约（`:430-471`），输家返回 null 不抛错 |
| 31 | `verification_card_outbox` | `src/circle-invitation/circle-invitation.service.ts:1363` | 5 分钟 | A | `cardAttempts` 抢占（`:1403-1413`）+ 幂等键，与 28 同型 |
| 32 | `circle_invitation_reconciliation` | `src/circle-invitation/circle-invitation.service.ts:1950` | 5 分钟 | A | Serializable + 成员 advisory 锁 + `status='PENDING'` 条件写（`:1963-1991`），通知只由赢家发 |
| 33 | `storage_audit` | `src/upload/storage-audit.service.ts:101` | 每天 5 点 | A | `runWithJobLease`（`:105`）；盘点只读；`UPLOAD_INTENT_GC_MODE=delete` 时删对象另有 15 分钟行级租约（`src/upload/upload-intent.service.ts:232-248`） |

备注（都判为不必修，写下来免得以后重查）：

- ① 任务 3：一页处理完把任务行写回 PENDING 且 generation 不变，另一进程手里的旧快照
  可以再认领一次、用旧游标重做一页。后果是实时事件多播一遍；提醒被幂等键挡住。
- ② 任务 13：`evictAllSeats`（`chat-circle-sync.service.ts:852-921`）不在圈子锁内，
  Redis 租约失效的那几毫秒里「圈子已解散」通知可能发两条。单进程下定时任务和请求路径
  之间已有同类竞争。
- 用 Redis 任务租约的 8 处（`src/redis/job-lease.ts:22`）在 Redis 答不上来时是**照跑**
  （宁可重复，不能停摆），所以它们都另有行级兜底；逐个推过，两个进程同时跑仍然安全。
- 8、10、11、16 依赖未显式指定隔离级别的事务是 READ COMMITTED。代码没改默认值；
  数据库的 `default_transaction_isolation` 若被改过，11 会重复发「帖子已自动结束」。
- 监控：抢不到租约的实例记 skipped、不刷自己的心跳；`CronJobStalled` /
  `CronJobFailing` 已按 `max by (exported_job)` 聚合
  （`monitoring/prometheus/alerts.yml:216`、`:237`），不会误报。反过来，某个实例一直
  抢不到时它的 `last_result` 停在播种值 1，会盖住另一个实例的持续失败，只能等
  `CronJobStalled`（3 × 周期）。

### 不走 `@TrackedCron` 的定时入口

全仓没有裸 `@Cron` / `@Interval` / `@Timeout`。另有：

| 入口 | 位置 | 类 | 依据 |
|---|---|---|---|
| `group_admission_delivery`（`@TrackedInterval`，10 秒） | `src/chat/group-admission.service.ts:1090` | **C（轻）→ 已修** | 见下 |
| `admin_group_operation`（`@TrackedInterval`，5 秒） | `src/admin-community/admin-group-operation.processor.ts:37` | A | `PENDING→PROCESSING` 原子认领，完成与审计日志以 `claimedAt` 为条件 |
| 聊天媒体待删重投（裸 `setInterval`，60 秒） | `src/chat/chat-media.service.ts:180` | A | 逐行 advisory 锁 + 锁后重读 + 5 分钟租约 |
| 在线租约续期 / 实例心跳 | `src/chat/chat-presence.registry.ts:100`、`:105` | — | 只动本实例自己的条目 |
| `/realtime` ping | `src/realtime/realtime.gateway.ts:238` | — | 只管本机连接 |

**`group_admission_delivery`（唯一一处重复有害，已实现修复）。** 取一批待投递 → 逐条
开事务 → 锁群会话行 → 投递 → 标 `deliveredAt`。两个进程会取到同一批；第二个进程等到
行锁之后没有复核 `deliveredAt`，于是原样再走一遍。站内通知行（按 id upsert）、离线
推送、邀请卡片消息（clientMessageId）都不会重复落库，但会**对同一条通知再发一次实时
事件和未读广播、把邀请卡片重播一次、JOINED 时多发一次「已加入」**。批量邀请时基本
必现。单进程下有进程内闸，所以是多实例新增的。

修法（`src/chat/group-admission.service.ts`，拿到群会话行锁之后）：重读这条投递，
`deliveredAt` 已置就返回。对方持锁直到提交，READ COMMITTED 下锁后重读一定看得到。
输掉的一方不算失败、不加重试次数。测试：`group-admission.service.spec.ts` 的
`skips a delivery another instance finished while this one waited for the group lock`。

## 2. 进程内状态

逐个看了网关、推送、广播、限流、缓存里的 `Map` / `Set` / 模块级变量。**没有发现
「同一事件被两个进程各处理一次」「踢人只踢得到本进程」「在线 / 输入 / 已读只存在一个
进程里」这三类问题。**

### 2.1 会出错

**`@Throttle` 限流是每实例一份。** `src/app.module.ts:79-82` 的
`ThrottlerModule.forRoot` 没配 `storage`，用的是进程内存储。全仓 148 处 `@Throttle`
（29 个 controller）在轮询下额度变成 N 倍。

- 真正的安全闸**不受影响**：登录 / 注册 / 改密 / 刷新 / 找回密码 / 安全码 / 搜账号 /
  加好友 / 送礼走的是 express-rate-limit + Redis（`src/setup.ts:304-326`、
  `:520-551`）；猜码次数在库里；socket 上的 9 个限流、上传配额、访客上传配额都走
  Redis。
- 只靠 `@Throttle` 的会放大，值得点名的：匿名的临时聊天入房
  （`src/temp-chat/temp-chat.controller.ts:68`、`:89`）、发起通话
  （`src/call/call.controller.ts:54`、`:68`、`:103`，每次都会给对方推来电）、登录验证
  的外层限流（`src/auth/auth.controller.ts:233`、`:261`、`:308`、`:336`、`:437`，内层有
  库里的次数兜底）。
- 没有动手：这是 148 个入口的行为变更，且要决定 Redis 故障时的回退。修法是给
  `ThrottlerModule` 配一个 Redis 存储（`RedisService.incrementWithTtl` 已有，
  `src/redis/redis.service.ts:616-649`），Redis 不可用时退回内存。N=2 时最坏是额度
  翻倍，是否接受见 8.1。

### 2.2 行为退化但可接受

| 位置 | 每进程一份的东西 | 多实例下 |
|---|---|---|
| `src/chat/chat-push.service.ts:132`（`CHAT_PUSH_COALESCE_MS = 1000`） | 推送合并窗口 | 一条消息的离线推送只由**受理发送的那个进程**发（入口 `chat.gateway.ts:1466`、`chat-system-message.service.ts:145`、`chat-direct-auto-reply.processor.ts:536`），不会各推一次；判断收件人是否在线用的是 Redis 注册表，不会出现「人在 B 实例、A 当他离线」。退化的只是合并：同一会话 1 秒内由不同实例受理的消息各开一个窗口，每会话每秒最多 1 条推送变成最多 N 条（安卓按会话 tag 互相替换，多半仍只看到一条） |
| `src/realtime/socket-admission.ts:11-17` | `SocketAdmission(2000, 128, 10_000)`：本进程连接上限 2000、同时待认证 128、10 秒没认证完就关 | chat 和 `/realtime` 各一份，总预算 ×N。它保护的是单进程内存，**不用随实例数调小**；但容量要按 N−1 算（见第 9 节） |
| `src/realtime/realtime.gateway.ts:28` | `/realtime` 单用户 5 条连接上限 | 全局最多 5×N（chat 的 10 条是按 Redis 全局算的） |
| `src/sensitive-word/sensitive-word.service.ts:40-45` | 敏感词表，60 秒 TTL | 管理台改词后，别的实例最迟 60 秒生效，没有跨实例失效广播 |
| `src/support/support.service.ts:130-137`、`src/admin-console/console-releases.service.ts:32-40`、管理台看板 | 30–45 秒缓存 | 别的实例的修改最迟 30–45 秒可见 |
| `src/geo/geo.service.ts:93-96` | 高德逆地理缓存 24 小时 | 命中率按实例摊薄，高德额度最坏消耗 ×N |
| `src/interceptors/http-capacity.interceptor.ts:14-15` | HTTP 并发闸 128/进程 | 总并发 128×N，下游连接池仍是每实例 10 |
| 各处日志 / Sentry 采样窗口 | — | 同一类告警日志和上报量 ×N |
| `chat_users_online` 等 gauge | — | 各实例只数自己的，跨实例求和会把多设备用户重复计数；`circle_outbox_pending/dead` 每实例各报一份，看板若对它 `sum` 会翻倍 |
| Redis 故障时的各种内存回退（限流、上传配额） | — | 只在 Redis 故障期间变成每实例一份 |

在线状态（`src/chat/chat-presence.registry.ts`）**跨进程一致**：真值是 Redis 的三张
ZSET，本进程 Map 只记自己登记过什么；实例心跳 20 秒一次、TTL 90 秒，读取时滤掉心跳
已消失的实例。进程被强杀后最迟 90 秒它的连接就不再算在线。

### 2.3 拿不准

**入群请求落在 A、连接在 B 时，在线记录没人续期**
（`chat-presence.registry.ts:236-260`）：A 往 Redis 写了一条 90 分钟到期的在线条目，B
的续期表里没有这个会话。90 分钟后这个会话的消息会推送到用户正开着 App 的手机上，直到
他重连。**现在不触发**，因为访问令牌 1 小时到期会强制重连、重连时按当前座位重新登记。
谁把 `JWT_EXPIRES_IN` 调到 90 分钟以上，这个问题就活了。推理成立，没有实测。

## 3. 实时通道

两套互相独立的 WebSocket，挂在同一个端口：

| | `/chat-ws` | `/realtime` |
|---|---|---|
| 实现 | socket.io 4.8.3 | 原生 `ws` |
| 跨实例 | `@socket.io/redis-adapter`（经典 pub/sub） | 自己写的 Redis pub/sub 背板（`src/realtime/realtime.service.ts:1132-1169`、`:1253-1276`） |

- **广播**：全部经房间、经适配器（`src/chat/chat-broadcast.service.ts`）。没有遍历
  本地 socket 表找人再 `emit` 的投递路径。
- **踢下线 / 会话吊销 / 单设备登录**：走 Redis 发布订阅 `circle:realtime:revoke`
  （`src/auth/session-revocation.broadcast.ts:19`），每个实例都订阅、各自只断自己手上的
  连接（`chat.gateway.ts:766-812`）。这里「遍历本机」是对的，触发源是跨进程广播。
- **入群拉进房 / 移出撤出房**：`fetchSockets()` 经适配器问遍所有实例再逐个下发，默认
  5 秒超时。有一个实例卡住时这些接口多等 5–10 秒；拿列表失败时被移出的人会继续收到
  按会话房广播的元数据（已读、输入、表情），直到重连。消息正文不受影响（按库里现查的
  成员投递）。
- **传输方式**：服务端没限制（socket.io 默认允许长轮询），但自家客户端都只用
  WebSocket，**不需要粘滞会话**：
  - App 和 App 网页版：`circle-im/src/chat-core/socket-manager.ts:495-497`，
    `transports: ['websocket']`；
  - 访客网页：`temp-chat-web/src/lib/chatClient.ts:357-362`，同上，全仓只有这一处；
  - 管理台（`circle_admin_web`）不用 WebSocket，后端也拒绝管理台令牌连 chat。

  第三方或手写客户端用长轮询会在无粘滞多实例下 400（`Session ID unknown`），网关已单独
  计数（`engine_session_unknown`）。建议服务端显式写 `transports: ['websocket']`，把
  「不支持轮询」变成约定而不是巧合（未做）。

### Redis 不可用时的回退在多实例下是否安全

**不够安全，有一条低概率、后果重的路径：**

1. **适配器晚挂载**（`chat.gateway.ts:331`、`:493-528`）。挂载是 fire-and-forget；
   订阅连接这一刻没连上，进程就先用内存适配器对外服务，5 秒 → 60 秒无限退避重试，
   约 75 秒后才打一条 error。这段时间跨实例广播直接丢，而在线注册表是跨实例的 —— 别的
   实例上的收件人被判成「在线前台」，socket 消息和推送都收不到。重试成功那一刻
   `io.adapter(...)` 会新建一个空的适配器（对照 socket.io 4.8.3 源码），此前连进来的
   连接的房间关系留在旧适配器里，**此后什么广播都收不到，直到它们自己重连**（最长
   1 小时）。触发条件窄：命令连接通、订阅连接这一刻没连上。后果是推出来的，没有复现。
2. **没有信号能发现「跨实例广播在丢」**（`src/health/health.endpoint.ts:80-111`）。
   `/readyz` 只查数据库和命令连接的 PING，不含适配器是否已挂、订阅连接是否活着；适配器
   的发布失败只会变成一次 unhandledRejection。
3. **运行中 Redis 断开**：发布立即失败、不排队、不补发，本机连接照常收到，别的实例上
   的连接收不到，恢复后也不补。兜底是推送侧「Redis 读不到就谁都不排除」加上客户端按
   revision 增量同步，消息本体在库里不丢。**多实例后 Redis 是实时投递的硬依赖**：
   单实例时 Redis 断了本机照样送得到，N 个实例时有 (N−1)/N 的投递依赖它。

修法方向（未做，见 8.3）：启动时等适配器挂好再 `listen`；加一个
`chat_redis_adapter_attached` 指标并计入 `/readyz`。

## 4. 数据库与 Redis 连接

- 每进程**一个** pg 池，默认 10 条（`src/prisma/prisma.service.ts:20`），
  `DATABASE_POOL_MAX` 可配。没有第二个池、没有 LISTEN/NOTIFY 专用连接。
- PostgreSQL 的 `max_connections` **没有在任何地方设置**，是 PG16 默认的 100（扣掉给
  超级用户保留的 3 条，可用 97）。本机验证栈 `SHOW max_connections` 也是 100。
- 其它占用：postgres-exporter 约 1 条、pgBackRest 备份时 1 条、迁移 / 发版预检 1–2 条、
  恢复演练临时 1 条 —— 按 **10 条**预留（后两项是按常规行为估的，没在测试服上看
  `pg_stat_activity`）。
- **蓝绿发版期间新旧两色同时在线，应用侧是 2N × 池大小。** `PostgresConnectionsNearMax`
  告警线是 80%（`monitoring/prometheus/alerts.yml:926`）。

每实例池大小的建议值（`max_connections` 保持 100、蓝绿发版）：

| 每色实例数 N | 建议 `DATABASE_POOL_MAX` | 发版期间峰值 | 占比 |
|---|---|---|---|
| 1 | 10（现状） | 2×10 + 10 = 30 | 30% |
| 2 | 10（不用改；想放宽最多 15） | 4×10 + 10 = 50 | 50% |
| 3 | 10 | 6×10 + 10 = 70 | 70% |
| 4 | **8** | 8×8 + 10 = 74 | 74% |

算法：`池大小 ≤ (0.8 × max_connections − 10) ÷ 2N`。N=4 仍用 10 的话发版期间是 90 条，
越过告警线、离上限只差 7 条。要更大的池就显式调大 `max_connections`（同时看 PG 的 1g
内存够不够），而不是压着上限跑。池是空闲时按需增长的：本机两个实例空闲时一共只占 12
条。

注意压测里 60 条/秒垮掉时 `db_pool_waiting=1211`、而 PostgreSQL 只用了 39% 的一个核：
池在排队是事件循环顾不过来的结果，不是库慢，**单纯加大池解决不了**。

Redis：每进程 7 条连接（命令连接兼适配器发布、适配器订阅、两个吊销订阅、隐私变更
订阅、`/realtime` 背板订阅、徽章缓存失效订阅），N 个实例 7N 条、发版期间 14N 条，
默认 `maxclients` 10000，不是问题。所有命令（含广播发布、限流、在线注册表）共用一条
命令连接、超时 1 秒，Redis 一慢会一起超时。

## 5. 发版流程在每色多实例下要改什么

| 环节 | 现状 | 每色 N 个实例 |
|---|---|---|
| 蓝绿切换 | 起另一色的 1 个容器 → 健康 → Caddy 切过去 → 烟测 → 停旧色 | **已实现**：一条命令起新色的 N 个容器，全部健康后 Caddy 一次性切到 N 个上游，烟测通过后停掉旧色的全部容器。任一副本不健康 = 整色失败、整色清掉，旧色不动 |
| 健康检查 | compose healthcheck 探 `/readyz`；Caddy 不探 | **已实现**：多上游时 Caddy 启用 `least_conn` + 连不上即改投 + 主动探 `/healthz`。单上游时不启用，行为不变 |
| 迁移只跑一次 | `compose run --rm migrate` 在起新色之前跑一次；应用启动不跑迁移 | **不用改**：还是发版脚本里的那一次，和实例数无关 |
| 优雅停机 | 收到 SIGTERM：主动断开全部 WebSocket（客户端看到 `transport close`，自动重连）、删实例心跳、把积压的推送窗口推完 | **顺序已满足，时限没设**：脚本先切 Caddy、烟测通过后才停旧色，所以停的时候已经没有流量。两处要知道，见下 |
| 回滚 | Caddy 切回旧色，清掉新色 | **已实现**：切回旧色的全部上游，清掉新色的全部副本 |
| 实例数变化 | — | **已实现**：每色实际起了几个记在 `.release/replicas-<颜色>`；改小实例数后的下一次发版靠它把旧色的副本全停掉 |

优雅停机的两处缺口（单实例今天就有，多实例下更容易撞上，**未改**）：

- **HTTP 在途请求没有排空**（`src/main.ts:98-122`）：`app.close()` 先销毁连接池和
  Redis，再关 HTTP 服务器；收到信号也不会先让 `/readyz` 变 503。现在没出事是因为发版
  「先摘流量再发 SIGTERM」。**任何绕开发版脚本的停实例（手工 `docker stop` 某个副本、
  缩容）都会有一批 5xx** —— 要先把它从 Caddy 上游里摘掉。
- **`stop_grace_period` 没设**，是 Docker 默认的 10 秒；推送冲刷（单次请求超时 8 秒）
  和 `pool.end()` 可能超时被 SIGKILL，那样实例心跳键没删，别的实例要 90 秒后才把它的
  连接判死。建议设 30 秒（改的是 `docker-compose.prod.yml`，会改变 N=1 的配置，所以
  留给人决定）。

切流的代价和现在一样：`caddy reload` 默认会把经它的 WebSocket 一次性断开（按 Caddy
文档，未实测），全体客户端同时重连。多实例后这次重连要过每实例 128 的待认证闸，瓶颈
在每进程 10 条的连接池（每次握手查 4–5 次库），会自愈但要几轮退避。

## 6. 已实现

### 6.1 部署：每色 N 个后端容器

| 文件 | 改动 |
|---|---|
| `docker-compose.replicas.yml`（新） | 每色的第 2–4 个容器：`circle_be_2..4`（`circle-be-blue-2..4`）、`circle_be_green_2..4`（`circle-be-green-2..4`）。`extends` 复用 `circle_be` 的全部配置，各有自己的日志卷 |
| `deploy/release-deploy.sh` | 读 `.env` 的 `CIRCLE_BE_REPLICAS`（1–4，默认 1）；所有按颜色的操作（起、等健康、切流、停、删、回滚、进维护态）改成按「颜色的全部成员」 |
| `deploy/Caddyfile.admin` | 三处 `reverse_proxy` 导入 `circle_be_lb_{$CIRCLE_BE_LB:single}`；`single` 是空片段，`pool` 是负载均衡 + 健康检查 |
| `deploy/caddy-entrypoint.sh` | Caddy 重启时从 autosave 恢复**全部**上游；多于一个就选 `pool`；两种颜色混在一起仍然拒绝启动 |
| `deploy/overlay-trusted-release-tooling.sh`、`.github/workflows/release.yml` | 手动回滚历史 tag 时把 `docker-compose.replicas.yml` 一并带上 |
| `monitoring/prometheus/prometheus.prod.yml` | DNS 发现加上副本的 6 个名字（不存在的名字不产生抓取目标，和退役的颜色一样） |

为什么这么设计：

- **不用 `--scale`**：它要求去掉 `container_name`，而 Caddy 上游、Prometheus 发现、
  Caddy 重启恢复都靠固定容器名认颜色；去掉就改变了 N=1 的行为。
- **上限写死 4**：单机再多就该拆机器了，那时这套单机蓝绿本身也要换。
- **实例数放 `.env` 而不是发版参数**：它是主机的属性（核数、内存），而自动发版的环境
  变量是固定的。
- **Caddyfile 不用改就支持多上游**：`{$CIRCLE_BE_UPSTREAM}` 是先做文本替换再分词，
  空格分隔的多个地址各成一个上游（已用真实 Caddy 2.11.7 验证）。

启用方法（**不要在测试服上做**，见第 9 节）：在主机的 `.env` 加一行
`CIRCLE_BE_REPLICAS=2`，下一次发版生效；改回 `1` 再发一次版即恢复单实例。

### 6.2 定时任务

`group_admission_delivery` 的重复投递，见第 1 节。只有这一处，不涉及资金。

### 6.3 「N=1 与改动前逐字节一致」的证明

三条，都可重跑：

1. **执行轨迹**：用 `origin/main` 那份**未改动**的 `test/release-deploy.spec.sh`
   （53 条用例、52 个场景，覆盖正常发版、各种失败回滚、信号中断恢复、不可逆迁移）
   分别驱动原版和新版 `release-deploy.sh`，逐个场景收集执行的每一条 docker 命令、
   脚本输出、落盘的状态文件，路径归一化后 `cmp`：2356 行**逐字节相同**
   （sha256 `6a60d95ea464b826…`）。
2. **Caddy 配置**：真实 Caddy（带限流模块，2.11.7）对原版和新版 `Caddyfile.admin`
   各做 `caddy adapt`，默认上游和 `circle-be-green:3000` 两种情况下 JSON **逐字节
   相同**。
3. **Compose 配置**：`docker-compose.prod.yml`、`docker-compose.release.yml` 一个字节
   没动；N=1 时发版脚本不加载 `docker-compose.replicas.yml`。

上面第 1 条比的是全部场景，但要拿着旧脚本才能重跑（比对脚本 `prove-n1-identical.sh`
在本次任务的共享笔记目录里）。留在仓库里、每次 CI 都跑的是三条：

- `test/fixtures/release-deploy-single-replica.commands`：用**改动前的脚本**录下的
  默认发版 31 条 docker 命令，
  `test_single_replica_release_runs_the_recorded_docker_commands` 逐条对照。
- `test_single_replica_default_never_touches_the_replica_overlay`：默认发版不加载
  副本 overlay、不传 `CIRCLE_BE_LB`、不写副本记录。
- `scripts/check-caddy-backend-pool.sh`（CI 在构建出 Caddy 镜像后跑）：把负载均衡
  那一节和三处 import 从 Caddyfile 里删掉 —— 删完与改动前的文件逐字节相同 —— 两份
  各 `caddy adapt`，JSON 必须逐字节相同；再用两个上游加 `CIRCLE_BE_LB=pool` 跑
  `caddy validate`，并确认三处反代都拿到全部上游、`least_conn` 和探活。只有真实的
  Caddy 能回答「import 的名字里能不能展开环境变量、空片段合不合法」。

### 6.4 测试与本机 N=2 验证

- `test/release-deploy.spec.sh`：原 53 条 + 新增 11 条（默认命令序列的基准对照，以及
  10 条多实例用例：起两个副本并入池、
  下一次发版停掉旧色全部副本、实例数改回 1、一个副本不健康整色失败、烟测失败整色
  回滚、停机模式先停全部副本、非法配置在任何 docker 命令之前被拒、正在重启的副本
  留在池里、残留副本删不掉就停下），64 条全过。
- `scripts/release-hardening.test.mjs`：改 2 处断言（脚本文本变了），新增 2 条
  （Caddy 重启恢复整个池、副本契约）。
- Linux 容器里按 CI 的部署测试步骤各跑一遍原版和新版：都是全绿（新版 37 / 20 / 77 +
  发版 64 条）。本机 macOS 上有 3 组在未改动的 main 上就失败（系统自带 bash 3.2、
  `/etc` 是软链、没有 `flock`），与本次改动无关。
- `src/chat/group-admission*.spec.ts`：65 条通过。
- `test/postgres/group-admission-delivery-dedup.pg-spec.ts`（真库，PostgreSQL 16、
  `read committed`）：两个服务实例取到同一条投递，赢家持锁停在投递里，确认输家已经
  排进锁队列后放行；只投递一次、不消耗重试次数。去掉修复后这条用例失败（输家多投
  一次），说明重复在真库上确实会发生。

本机 N=2（Docker Desktop，从这个工作区构建的生产镜像，三份 compose 文件原样叠加，
独立的 compose 项目，用完已拆除）：

| 验证 | 结果 |
|---|---|
| 迁移用发布镜像跑一次，再同时起 `circle_be` 和 `circle_be_2` | 两个都 healthy，各自打出 `redis adapter attached (multi-instance)` |
| 按发版脚本的方式 `caddy validate` + `caddy reload`（两个上游 + `CIRCLE_BE_LB=pool`） | 通过；公网烟测路径返回 401 JSON |
| 用户 1、3 直连实例 A，用户 2、4 直连实例 B；私聊双向、群聊 | 9 项全过，跨实例送达 26ms 以内 |
| 4 个用户各 3 条连接全部经 Caddy | 12 条连接 6 / 6 摊在两个实例上（按 Redis 里的连接租约数），19 项收发全过 |
| 停掉一个实例，其间经 Caddy 每 250ms 一个请求共 60 个 | 60 个全部正常；只剩一个实例时收发照常 |
| 重启 Caddy 容器 | 入口脚本从 autosave 恢复出两个上游、`least_conn` 和探活 |

两个实例并行跑了几分钟，定时任务没有失败或异常（窗口太短，只能说明没有立刻出错）。
空闲时每个实例约 210–280MiB。

验证中发现的两件事：

- **`REDIS_REQUIRED=true` 时镜像起不来**，见 8.2。验证是在 `REDIS_REQUIRED=false` 下
  做的（适配器照常挂上）。
- `compose start <服务>` 在没有 migrate 容器的栈上会报 `missing dependency migrate`
  （`depends_on: migrate: service_completed_successfully`）。蓝 / 绿基础服务同样如此，
  不是副本特有；真实主机上首次开通留下的 migrate 容器还在，所以没出过事。发版脚本的
  「重启旧色」路径（`ensure_live`）依赖这一点，值得知道。

### 6.5 独立审查的结论

发版脚本的多实例路径另请了一轮独立审查（完整读了 1150 行脚本和相关文件）。结论：
没有会切错色、漏停旧色或让中断恢复找不全容器的状态机漏洞；确认的三处已修并带测试：

- **池被静默收窄**：在役色某个副本正在重启时，对齐 Caddy 只会拿到剩下的实例，这次
  发版若在切流前失败，池就一直窄到下一次发版，没有任何信号。改为多实例时把没在跑的
  成员也留在池里，由探活绕开、回来后自动恢复。
- **残留副本删不掉被吞**：继续往下走会把记录改小甚至删掉，删不掉的容器从此没人管。
  改为删不掉就停下、保留记录。
- **Caddy 重启后恢复的上游顺序与脚本不同**：下一次发版开头的对齐会变成一次真
  reload，白白断开全部 WebSocket。改为按同一顺序恢复。

审查存疑的一条已实测排除：「实例刚死时，带请求体的 POST 因为请求体已被关闭而无法
改投，还会把健康实例一起摘掉」。用 Caddy 2.11.7 和同一份池配置，在一个上游刚消失
（容器被杀）和端口拒连（容器在、进程没起来）两种情况下各发 40 个带 JSON 体的 POST，
全部成功，最慢 0.31 秒。

留着没改、知道即可：

- Node 的 HTTP keep-alive 默认 5 秒，Caddy 到上游的空闲连接保留 2 分钟。Caddy 复用
  一条刚被 Node 关掉的连接时请求会 502（单实例今天就有）；池模式下这种错误还会让
  那个实例被摘 10 秒。测试服现有的反代日志里这类错误多不多没有查，多的话把
  `max_fails` 提到 2–3。
- 退役旧色用的是 `compose rm -f`（不带 `-s`）：旧色所有成员恰好都不是 running、但有
  一个正在重启时会漏删，而记录已经清掉。触发条件苛刻，下一次轮到该色会被重建。

**没有验证的**：真实的 `release-deploy.sh` 没有在真机上端到端跑过 N=2（它要 launcher、
GHCR digest 镜像和 `flock`），脚本逻辑只有桩测试覆盖；没有做 N=2 的压测。

## 7. 只是方案、没有实现

| 项 | 为什么没做 | 方向 |
|---|---|---|
| `@Throttle` 跨实例共享 | 148 个入口的行为变更 | 2.1 |
| 适配器晚挂载 / 就绪探针 | 改启动顺序和健康检查语义 | 第 3 节 |
| `REDIS_REQUIRED=true` 启动竞态 | 与多实例无关的既有问题，但它是多实例的前置 | 8.2 |
| 「某个副本掉了」的告警 | `absent(up{job="circle-be"})` 只在**全部**后端都没了才响，N>1 时掉一个副本没有告警（Caddy 的探活会绕开它，用户无感，但容量少了 1/N）。Prometheus 不知道期望的副本数：用「比过去一段时间少」来猜，会在发版换色和主动缩容时误报，过了窗口又自己消掉 | 让后端导出期望副本数（或由发版脚本写一个 textfile 指标），再加 `count(up{job="circle-be"} == 1) < 期望数`。只影响 N>1，开多实例之前补上 |
| 副本的文件日志进 Loki | 日志 overlay 用 `external: true` 的卷，静态加上副本的卷会让**没开多实例的主机起不来日志栈** | 另写一个 `monitoring/docker-compose.logs.replicas.yml`，只在开了多实例的主机上叠加；`alloy/config.alloy` 的路径通配同步加上。在那之前副本的日志只在 `docker logs` 里 |
| `stop_grace_period` | 会改变 N=1 的配置 | 第 5 节 |
| 服务端显式 `transports: ['websocket']` | 行为变更 | 第 3 节 |
| 入群时跨实例续期在线记录 | 当前配置下不触发 | 2.3 |

## 8. 上线多实例之前必须由人确认

1. **`@Throttle` 额度变成 N 倍是否接受。** N=2 时匿名入房从 10 次/分钟变 20 次、发起
   通话从 10 次变 20 次。不接受就先做 2.1 的 Redis 存储。
2. **`REDIS_REQUIRED` 在正式服上到底是什么值，以及启动探测的竞态。** 本机用模板里的
   `REDIS_REQUIRED=true` 起镜像，**连续十几次全部启动失败**
   （`Application failed to start … redis.service.ts:966`）；改成 `false` 后同一个镜像
   9 秒内 healthy，日志是 `Redis is unavailable during production startup: Stream isn't
   writeable and enableOfflineQueue options is false`，紧接着 Redis 就连上了。原因：
   限流存储在 `setupApp` 里先发起了连接，`RedisService.onModuleInit`
   （`src/redis/redis.service.ts:62-95`）拿到的是一个「正在连接」的客户端，立刻 PING，
   而客户端关了离线队列，于是这一下必失败；`REDIS_REQUIRED=true` 时这就是启动失败。
   能不能过取决于前面的模块初始化耗时是否长过 Redis 握手，本机（Docker Desktop）上必现。
   - 需要确认：测试服和正式服的 `.env.production` 里这一行是什么。如果是 `true` 而一直
     能起来，说明那边是靠时序过的，换机器可能就起不来；如果是 `false` 或没有这一行，
     说明模板要求的「生产强制依赖 Redis」实际没生效。
   - 多实例**必须**是 `REDIS_REQUIRED=true`（否则 Redis 不通时各实例各自为政），所以这
     个竞态要先修：`onModuleInit` 里等连接就绪再 PING。
3. **Redis 适配器晚挂载**（第 3 节）是否要在上线前修。触发面窄但后果是「一批用户
   收不到任何消息且没有告警」。至少要加上能发现它的指标。
4. **Redis 的可用性。** 多实例后 Redis 是实时投递的硬依赖。内置 Redis 是单节点；
   `DEPLOY.md` 已建议生产用带自动故障转移的托管 Redis。
5. **回滚到本次改动之前的 tag 时，先把 `CIRCLE_BE_REPLICAS` 设回 1 并发一次版。**
   自动发版走的是目标 tag 自己的脚本，旧脚本不认识副本：它只会停掉旧色的基础容器，
   副本会留在那里继续跑定时任务。手动回滚（workflow_dispatch）带的是当前脚本，没有
   这个问题。
6. **用主机本地 Caddyfile 的机器要手工同步负载均衡配置。** `.env` 里设了
   `CADDY_CONFIG_PATH` 的主机（测试服就是，见 `docs/operations/tencent-auto-deploy.md`）
   挂的是 `.release/` 下自己的 Caddyfile，发版不会更新它。那份文件里没有
   `circle_be_lb_pool` 的话，多个上游仍然生效（环境变量是文本替换），但是 Caddy 默认
   的随机分配、**没有重试、没有探活**：一个实例挂了就有 1/N 的请求直接 502。开多实例
   之前把 `deploy/Caddyfile.admin` 里的两个 `circle_be_lb_*` 片段和三处 `import` 抄
   进去，`caddy validate` 通过后再发版。
7. **数据库 `default_transaction_isolation`** 是 `read committed`（第 1 节备注）。
8. **正式服的规格**（第 9 节），以及在那台规格上重跑一次分级压测。

## 9. 正式服的核数和实例数

依据是 2026-11-23 在测试服（2 核 3.7G，库同机）做的分级压测（结果和脚本在另一个
工作区 `circle_be-wt/perf-main/scripts/perf/`，尚未入库；`results/load-1123-2137`、
`-2149`。每个虚拟用户 5 秒发一条，三成发到 30 人群）：

| 在线 | 实发 | 后端 CPU | PostgreSQL | Redis | 确认延迟 p95 | |
|---|---|---|---|---|---|---|
| 100 | 22 条/秒 | 39% | 36% | 3% | 328ms | |
| 200 | 44 条/秒 | 70% | 51% | 5% | 629ms | 主机负载 2.9，两个核基本用满 |
| 300 | 目标 60 条/秒 | 90% | 39% | 3% | 9.6 秒 | 垮：79% 的发送超时，连接池排队 1211 |

（CPU 是 `docker stats` 口径，100% = 一个核。）

两点线性拟合：

- 后端：约 **8% + 1.4% × 每秒消息数**（每个进程）。70% 时延迟已经翻倍，所以一个进程的
  实用上限按 **约 45 条/秒**算。
- PostgreSQL：约 **21% + 0.7% × 每秒消息数**（全局，可以用多个核）。

**为什么测试服不能开多实例**：44 条/秒时后端 70% + 库 51% + Redis、Caddy、系统，两个
核已经满了。再加一个后端进程没有核给它，只会让三者互相抢。

**每色 N 个实例、目标 R 条/秒需要的核**：
`N × 8% + 1.4% × R`（后端）`+ 21% + 0.7% × R`（库）`+ 约 30%`（Redis、Caddy、监控、
系统，其中 Redis 多了适配器的发布订阅，按宽估）。稳态占用控制在 65% 以内，留给
发版期间另一色的 N 个进程启动和突发。

| 规格 | 每色实例数 | 目标 | 稳态占用 | 说明 |
|---|---|---|---|---|
| **4 核 8G（建议起步）** | **2** | 约 90 条/秒（现在的 2 倍） | 16+126+21+63+30 = 256% ≈ 2.6 核，64% | 内存：发版期间 4 个后端（实测每个 0.3–0.4G，上限各 1G）+ 库 1G + Redis 0.8G + MinIO 1G |
| 8 核 16G | 4 | 约 180 条/秒（4 倍） | 32+252+21+126+30 = 461% ≈ 4.6 核，58% | `DATABASE_POOL_MAX=8`（第 4 节）；库这时要 1.5 个核，1G 内存要重新评估 |
| 8 核 16G，库迁出本机 | 4 | 同上，余量更大 | 32+252+30 = 314% ≈ 3.1 核，39% | 单机上限就到这里；再往上是多机，这套单机蓝绿要换 |

**同时在线的上限另算**：每个实例 2000 条连接，一个实例下线时它的连接全部重连到其余
实例，所以总在线要按 **(N−1) × 2000** 规划。N=2 时仍是 2000（和现在一样，但多了
一个实例故障不掉线的余量）；要 4000 以上同时在线得 N=3。

这组数字的局限，决定规格前请知道：

- 只有两个有效数据点（第三个已经垮了），拟合很粗；
- 压测的消息构成是合成的（三成 30 人群），真实的群更大时每条消息的扇出成本更高；
- 没有测过 N=2：适配器让每条广播经 Redis 转一手、每个实例都要解一遍，单条成本会
  高于单实例，「2 个实例 = 2 倍」是上界；
- 没有算上传、朋友圈、笔记这些非聊天接口的负载。

所以建议：**先按 4 核 8G、N=2 开一台预发机，把上面那套分级压测
（`run-load-steps.sh`）原样重跑一遍**，拿到 N=2 的真实斜率再定正式服规格。
