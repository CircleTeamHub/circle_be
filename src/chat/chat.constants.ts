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
  /** 服务端 → 客户端(个人房定向):接收者本人的会话成员关系变化 */
  conversation: 'chat:conversation',
  /** 双向:消息撤回(客户端带 ack 发起;服务端广播到会话房) */
  revoke: 'chat:revoke',
  /** 双向:送达水位(客户端收到 chat:msg 后上报,无 ack;服务端广播推进) */
  delivered: 'chat:delivered',
  /** 双向:表情回应(客户端带 ack;服务端广播到会话房) */
  reaction: 'chat:reaction',
  /** 双向:消息编辑(客户端带 ack;服务端广播到会话房) */
  edit: 'chat:edit',
} as const;

/** 消息编辑的时间窗(仅发送者本人;与撤回同窗)。 */
export const CHAT_EDIT_WINDOW_MS = 2 * 60_000;

/** 表情回应白名单:防任意字符串当 emoji 灌库。 */
export const CHAT_REACTION_EMOJIS: readonly string[] = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🙏',
];

/** 发送者本人的可撤回时间窗;圈主/管理员撤回群消息不受此限。 */
export const CHAT_REVOKE_WINDOW_MS = 2 * 60_000;

/** 个人房:登录即加入,用于跨会话的定向推送。 */
export const userRoom = (userId: string): string => `u:${userId}`;

/** 会话房:按 ChatMember 成员关系在连接时由服务端加入。 */
export const conversationRoom = (conversationId: string): string =>
  `c:${conversationId}`;

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

/**
 * 媒体消息 content 里的 object-key 字段表(key 字段名 → 读路径补的 URL 字段名)。
 * presign-on-read(ChatMediaService)与存量盘点(StorageAuditService)共用:
 * 新增带媒体的消息类型时在这里补一行,两边同时生效 —— 只改一边的话,
 * 要么新类型渲染不出图,要么它的对象全部被盘点误报成孤儿。
 */
export const CHAT_MEDIA_KEY_FIELDS: Record<
  string,
  Array<{ key: string; url: string }>
> = {
  image: [
    { key: 'key', url: 'url' },
    { key: 'thumbKey', url: 'thumbUrl' },
  ],
  voice: [{ key: 'key', url: 'url' }],
  file: [{ key: 'key', url: 'url' }],
};

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
  revoke: { limit: 10, windowMs: 10_000 },
  delivered: { limit: 30, windowMs: 10_000 },
  reaction: { limit: 20, windowMs: 10_000 },
  edit: { limit: 10, windowMs: 10_000 },
} as const;

/**
 * 临时房访客 chatToken 的 kind 声明。定义放在 chat 侧是因为依赖方向是
 * TempChatModule → ChatModule:签发在 temp-chat(LinkTokenService),
 * 验签在 chat 网关,反向 import 会成环。
 */
export const TEMP_CHAT_GUEST_TOKEN_KIND = 'temp-chat-guest';

/** 逐条已读回执单次返回的读者上限(超大群按前 N 展示)。 */
export const READERS_PAGE_MAX = 200;

/** 单次历史分页的最大条数。 */
export const HISTORY_PAGE_MAX = 100;
export const HISTORY_PAGE_DEFAULT = 50;

/** 会话列表单次返回上限(Phase 1 无分页,超过则取最近活跃的前 N 个)。 */
export const CONVERSATION_LIST_MAX = 100;

/**
 * 放宽/关闭焚毁前的兜底真删:分批处理的批量与批次上限。
 * 一次性 findMany 会把整段积压的完整 JSON content 拉进内存,后面再跟一条
 * 巨大的 IN 更新 —— 内存、查询参数上限、接口超时三样一起顶上来。
 */
export const RELAX_PURGE_BATCH = 500;
export const RELAX_PURGE_BATCHES_MAX = 20;

/** 离线撤回/编辑增量单次返回上限(重连后一次追平)。 */
export const MUTATION_PAGE_MAX = 200;
/** 增量最多回溯多久:超过这个跨度的离线,客户端本地缓存本来也已经翻篇。 */
export const MUTATION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
