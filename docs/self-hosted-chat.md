# 自研聊天(替代 OpenIM)—— 协议契约与架构

> Phase 1(本文档随代码落地):BE 网关 + 数据模型 + REST 冷路径。
> 协议移植自 squady(经 22 个月生产验证),按 circle 的 String uuid 主键与
> NestJS 惯例适配。前端镜像实现在 circle-im `src/chat-core/`。

## 架构

- **实时通道**:socket.io,挂在主 HTTP server 的 `/chat-ws` 路径
  (`/realtime` 已被会话吊销 raw-ws 网关占用)。普通 `@Injectable` +
  `main.ts` 里 `attach()`,与 RealtimeGateway 同款,不引 `@nestjs/websockets`。
- **冷路径**:REST(`/api/v1/chat/*`)承担打开 App 时的全量拉取与历史翻页。
- **存储**:Postgres 三表 `ChatConversation` / `ChatMember` / `ChatMessage`。
- **鉴权**:握手 `auth.token` 携带 app access JWT(不走 URL query),
  验签 + 吊销检查;**没有 OpenIM 式独立 IM token**(`/auth/im-token` 已随
  Phase 3 拆除)。

## 消息序与可靠性(核心不变量)

| 风险 | 防线 |
|---|---|
| 乱序 | `ChatMessage @@unique(conversationID, height)`;height 在事务内 `pg_advisory_xact_lock(7301, hashtext(conversationID))` 下按 max+1 分配 |
| 断线重发重复 | `@@unique(conversationID, senderID, clientMessageId)`;撞库返回原行(`reused`),不重广播 |
| 丢消息 | 先落库后 ack:ack 返回 = 已持久化;客户端超时未 ack 可安全重发(幂等兜底) |
| 已读回退 | `ChatMember.lastReadHeight` 只前进不后退(`updateMany` 带 `lt` 条件) |

## Socket 事件(跨仓契约,FE 镜像在 chat-core/protocol.ts)

客户端 → 服务端(均带 ack):

| 事件 | 载荷 | ack |
|---|---|---|
| `chat:send` | `{conversationId, type, content, d, replyToId?}` | `{ok:true, messageId, height, d}` \| `{ok:false, code, message?}` |
| `chat:read` | `{conversationId, height}` | `{ok:true}` \| `{ok:false, code}` |
| `chat:typing` | `{conversationId}` | 无 ack,尽力而为 |

服务端 → 客户端:

| 事件 | 载荷 |
|---|---|
| `chat:msg` | `ChatMessageDto`(发送者也收,靠 `d` 对账本地乐观消息) |
| `chat:read` | `{conversationId, userId, height}` |
| `chat:typing` | `{conversationId, userId}` |

房间:连接即入个人房 `u:{userId}` + 按 `ChatMember` 派生的全部会话房
`c:{conversationId}`(服务端派生,客户端无法自选)。

错误码统一走 `src/common/app-error-codes.ts` 的 `ChatErrorCode` 字符串码,
REST 与 socket ack 共用;敏感词命中 = `CHAT_SENSITIVE_WORD_BLOCKED`
(替代 OpenIM webhook 的数字码 73001,进程内同步调用 `SensitiveWordService.check`)。

## REST

- `GET /api/v1/chat/conversations` — 会话列表(末条消息、未读数、DIRECT 对端)。
- `POST /api/v1/chat/conversations/direct` `{peerUserId}` — 取或建单聊
  (directKey = 两 userID 码位序拼接,唯一约束防并发重建;拉黑双向拒建)。
- `GET /api/v1/chat/conversations/:id/messages?beforeHeight&limit` —
  height 键集分页,页内升序,`nextBeforeHeight=null` 表示到头。

## 防刷

每 socket 滑动窗口:send 20/10s、read 30/10s、typing 10/5s
(`chat-rate-limiter.ts`,单实例语义;多实例部署时每实例独立计数)。
REST 面沿用 ThrottlerGuard 每路由限流。

## Phase 2+ 待办(有意不在本批)

- 群聊会话与 Circle 成员的同步(建圈建会话、进圈入座、踢人离座)+ 系统消息。
- 离线推送:接现有 NotificationPushOutbox 管道,加「新消息」推送类型
  (@提及去重参考 squady mention 分流)。
- temp-chat 重接(guest 身份 → socket 鉴权的第二形态)+ chat-history 模块
  从 OpenIM 查询改为本表 SQL。
- 媒体:content 存 object key,读时 presign(复用 notes 的 presign-on-read)。
- 多实例:`@socket.io/redis-adapter`(依赖未装,单实例阶段不需要)。
- FE serverErrors 词表补 `CHAT_*` 五语种词条(接线批次一并做)。
