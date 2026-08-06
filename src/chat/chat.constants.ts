// 自研聊天常量:socket 事件名 / 房间命名 / 限流参数。
// 事件名是与前端 src/chat-core 的跨仓契约,改名两边要同步(有契约测试对齐)。

export const CHAT_WS_PATH = '/chat-ws';

export const CHAT_EVENTS = {
  /** 客户端 → 服务端:发消息(带 ack:{ok,messageId,height,d} | {ok:false,code}) */
  send: 'chat:send',
  /** 双向:客户端上报已读水位(带 ack);服务端广播成员已读推进 */
  read: 'chat:read',
  /** 双向:正在输入 */
  typing: 'chat:typing',
  /** 服务端 → 客户端:新消息 */
  message: 'chat:msg',
  /** 双向:在线状态(客户端带 ack 查询;服务端上下线广播) */
  presence: 'chat:presence',
} as const;

/** 个人房:登录即加入,用于跨会话的定向推送。 */
export const userRoom = (userId: string): string => `u:${userId}`;

/** 会话房:按 ChatMember 成员关系在连接时由服务端加入。 */
export const conversationRoom = (conversationId: string): string =>
  `c:${conversationId}`;

/**
 * height 分配的咨询锁命名空间(pg_advisory_xact_lock 的第一个 int4)。
 * 第二个键用 hashtext(conversationID) —— 哈希碰撞只会让不同会话偶发地
 * 串行化一次分配,不影响正确性。
 */
export const CHAT_ADVISORY_LOCK_NS = 7301;

/** 客户端可发送的消息类型;'system' 只能由服务端产生(防伪造)。 */
export const CLIENT_MESSAGE_TYPES = [
  'text',
  'quote',
  'image',
  'voice',
  'file',
  'location',
  'note-card',
  'friend-card',
  'circle-card',
  'transfer-card',
  'verification-card',
  'plaza-post-card',
] as const;

export const SYSTEM_MESSAGE_TYPE = 'system';

/** content JSON 序列化后的字节上限(超限直接拒收,防 socket 消息膨胀)。 */
export const MAX_CONTENT_BYTES = 8 * 1024;

/** content.text 的字符上限(与输入框限制对齐,双保险)。 */
export const MAX_TEXT_LENGTH = 4000;

export const CLIENT_MESSAGE_ID_MAX_LENGTH = 128;

/** 每 socket 的事件级滑动窗口限流参数。 */
export const CHAT_RATE_LIMITS = {
  send: { limit: 20, windowMs: 10_000 },
  read: { limit: 30, windowMs: 10_000 },
  typing: { limit: 10, windowMs: 5_000 },
  presence: { limit: 20, windowMs: 10_000 },
} as const;

/** 单次历史分页的最大条数。 */
export const HISTORY_PAGE_MAX = 100;
export const HISTORY_PAGE_DEFAULT = 50;

/** 会话列表单次返回上限(Phase 1 无分页,超过则取最近活跃的前 N 个)。 */
export const CONVERSATION_LIST_MAX = 100;
