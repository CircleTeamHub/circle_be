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

/**
 * 客户端可发送的消息类型。
 *
 * 判据是「这条消息断言的事实,服务端能不能替它背书」:
 * 分享类卡片(笔记/好友/圈子/广场帖)只是一个指针,收件人点开时会自己去取真值,
 * 伪造它顶多是发了条无效链接;而回执类卡片断言的是**已经发生过的服务端事实**
 * (钱已划走、身份已核验、通话已结束),客户端能发就等于能凭空捏造这些事实。
 *
 * 所以回执类一律放进 SERVER_MESSAGE_TYPES:transfer-card 由 GiftCardOutboxProcessor
 * 在结算之后签发,call-record 由 CallService 在通话结束后签发,verification-card
 * 同理(目前没有生产者,但语义属同一类,先按服务端专属收口,免得日后接线时漏掉)。
 */
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
  'plaza-post-card',
] as const;

export const SYSTEM_MESSAGE_TYPE = 'system';

/**
 * 只能由服务端写入的消息类型 —— 客户端发这些一律拒。
 * 这些类型都经 ChatSystemMessageService.insertServerMessage 落库,该方法不走
 * validateSendPayload,因此不受本清单限制。
 */
export const SERVER_MESSAGE_TYPES: readonly string[] = [
  SYSTEM_MESSAGE_TYPE,
  'transfer-card',
  'verification-card',
  'call-record',
];

/** 携带 object key 的媒体消息类型(读路径由 ChatMediaService 补签名 URL)。 */
export const MEDIA_MESSAGE_TYPES: readonly string[] = [
  'image',
  'voice',
  'file',
];

/**
 * 聊天媒体的对象前缀。上传 presign 固定把 key 落在 chat/{userId}/ 下,
 * 发送校验按 chat/{senderId}/ 收口,签发也只认这个前缀 —— 两道一起,
 * 聊天读路径就无法被用来续签别的目录(notes/ 等)里的私有对象。
 */
export const CHAT_MEDIA_KEY_PREFIX = 'chat/';

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

/**
 * 临时房访客 chatToken 的 kind 声明。定义放在 chat 侧是因为依赖方向是
 * TempChatModule → ChatModule:签发在 temp-chat(LinkTokenService),
 * 验签在 chat 网关,反向 import 会成环。
 */
export const TEMP_CHAT_GUEST_TOKEN_KIND = 'temp-chat-guest';

/** 单次历史分页的最大条数。 */
export const HISTORY_PAGE_MAX = 100;
export const HISTORY_PAGE_DEFAULT = 50;

/** 会话列表单次返回上限(Phase 1 无分页,超过则取最近活跃的前 N 个)。 */
export const CONVERSATION_LIST_MAX = 100;
