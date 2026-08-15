// 自研聊天的线上契约类型:socket 载荷 / ack / 广播 DTO。
// 与前端 src/chat-core/protocol.ts 镜像,字段名即协议,改动需两仓同步。
import type { AppErrorCode } from 'src/common/app-error-codes';
import type { TEMP_CHAT_GUEST_TOKEN_KIND } from './chat.constants';

/** chat:send 客户端载荷。d = 客户端生成的幂等键(deliveryId)。 */
export interface ChatSendPayload {
  conversationId: string;
  type: string;
  content: Record<string, unknown>;
  d: string;
  replyToId?: string;
}

/** chat:read 客户端载荷:上报某会话的已读水位。 */
export interface ChatReadPayload {
  conversationId: string;
  height: number;
}

/** chat:typing 客户端载荷。 */
export interface ChatTypingPayload {
  conversationId: string;
}

export interface ChatSendAckOk {
  ok: true;
  messageId: string;
  height: number;
  d: string;
}

export interface ChatAckError {
  ok: false;
  code: AppErrorCode;
  message?: string;
}

export type ChatSendAck = ChatSendAckOk | ChatAckError;
export type ChatReadAck = { ok: true } | ChatAckError;

/** 消息发送者的展示信息(随消息下发,前端免二次查询)。 */
export interface ChatSenderInfo {
  id: string;
  nickname: string;
  avatarUrl: string | null;
}

/** chat:msg 广播 / 历史接口共用的消息 DTO。 */
/** 被引用消息的只读快照(G-09 真引用),getHistory/发送路径批量附带。 */
export interface ChatReplyToSnapshot {
  id: string;
  height: number;
  senderNickname: string;
  type: string;
  /** 服务端生成的短摘要;原消息已撤回时为空串。 */
  preview: string;
  revoked: boolean;
}

/** chat:revoke 客户端载荷(带 ack)。 */
export interface ChatRevokePayload {
  conversationId: string;
  messageId: string;
}

/** chat:revoke 服务端广播。 */
export interface ChatRevokeBroadcast {
  conversationId: string;
  messageId: string;
  revokedBy: string;
}

/** chat:delivered:C→S 上报载荷与 S→C 广播同形。 */
export interface ChatDeliveredPayload {
  conversationId: string;
  height: number;
}

export interface ChatDeliveredBroadcast {
  conversationId: string;
  userId: string;
  height: number;
}

/** chat:reaction 客户端载荷(带 ack)。 */
export interface ChatReactionPayload {
  conversationId: string;
  messageId: string;
  emoji: string;
  op: 'add' | 'remove';
}

/** chat:reaction 服务端广播。 */
export interface ChatReactionBroadcast extends ChatReactionPayload {
  userId: string;
}

/** chat:edit 客户端载荷(带 ack);content 仅允许 {text}。 */
export interface ChatEditPayload {
  conversationId: string;
  messageId: string;
  content: { text: string };
}

/** chat:edit 服务端广播。 */
export interface ChatEditBroadcast {
  conversationId: string;
  messageId: string;
  content: Record<string, unknown>;
  editedAt: string;
}

/** 消息上的表情回应聚合(读路径批量附带)。 */
export interface ChatReactionSummary {
  emoji: string;
  userIds: string[];
}

export interface ChatMessageDto {
  id: string;
  conversationId: string;
  height: number;
  type: string;
  content: Record<string, unknown>;
  sender: ChatSenderInfo | null;
  replyToId: string | null;
  /** 被引用消息快照(读路径批量附带;原消息被物理删除时缺省)。 */
  replyTo?: ChatReplyToSnapshot;
  /** 撤回时间(ISO);未撤回为 null。撤回消息仍占 height,content 为空对象。 */
  revokedAt?: string | null;
  revokedBy?: string | null;
  /** 编辑时间(ISO);未编辑缺省。height 不变。 */
  editedAt?: string | null;
  /** 表情回应聚合;无回应缺省。 */
  reactions?: ChatReactionSummary[];
  /** 发送者本人的 ack 与广播共用此字段做本地乐观消息对账。 */
  d: string | null;
  createdAt: string;
}

/** chat:read 服务端广播:某成员的已读水位推进。 */
export interface ChatReadBroadcast {
  conversationId: string;
  userId: string;
  height: number;
}

/** chat:typing 服务端广播。 */
export interface ChatTypingBroadcast {
  conversationId: string;
  userId: string;
}

/**
 * chat:conversation 的变化种类:
 * - joined:本人入座(被拉进群/入圈获批/开圈聊播种)
 * - left:本人主动退出(通知同账号其它设备收走会话)
 * - removed:本人被移出(踢人/解散/停用/对账收敛)
 * - updated:会话元数据变化(预留,当前无生产方)
 */
export type ChatConversationChangeKind =
  | 'joined'
  | 'left'
  | 'removed'
  | 'updated';

/** chat:conversation 服务端定向下发(个人房):接收者本人的会话成员关系变化。 */
export interface ChatConversationBroadcast {
  kind: ChatConversationChangeKind;
  conversationId: string;
  /** 变化的成员即接收者本人;冗余带上便于客户端校验与多端复用。 */
  userId: string;
}

/** 会话成员 DTO(GET /chat/conversations/:id/members)。role 仅 GROUP 有值。 */
export interface ChatMemberDto {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

/** chat:presence 客户端查询载荷(带 ack:{[userId]: boolean})。 */
export interface ChatPresenceQuery {
  userIds: string[];
}

/** chat:presence 服务端广播:某用户上/下线。 */
export interface ChatPresenceBroadcast {
  userId: string;
  online: boolean;
}

/** 会话列表项 DTO(REST GET /chat/conversations)。 */
export interface ChatConversationDto {
  id: string;
  type: 'DIRECT' | 'GROUP' | 'TEMP' | 'SUPPORT';
  /** DIRECT 会话的对端用户;其余类型为 null。 */
  peer: ChatSenderInfo | null;
  circleId: string | null;
  /** GROUP 会话的圈子展示信息(名称/头像即群名/群头像);其余类型为 null。 */
  circle: { id: string; name: string; avatarUrl: string | null } | null;
  /** TEMP 会话的稳定房间信息;其余类型为 null。 */
  tempChat: { id: string; title: string } | null;
  lastMessage: ChatMessageDto | null;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  /** 会话级阅后即焚秒数(S-01);null=关。 */
  burnDurationSec?: number | null;
  lastMessageAt: string | null;
}

/** 历史查询的可选过滤(聊天记录搜索/媒体/按日期共用一个端点)。 */
export interface HistoryFilters {
  /** 消息类型白名单(如 ['image'] / ['text','quote'])。 */
  types?: string[];
  /** 文本关键词(content.text jsonb 包含匹配)。 */
  keyword?: string;
  /** 'YYYY-MM-DD',按 tzOffsetMinutes 解释成客户端当天。 */
  date?: string;
  /** 客户端时区偏移(new Date().getTimezoneOffset() 语义,分钟)。 */
  tzOffsetMinutes?: number;
  /**
   * 增量补拉游标(G-13 重连对账):取该 height **之后**的消息,升序返回。
   * 与 beforeHeight 互斥;续拉游标经 nextAfterHeight 返回。
   */
  afterHeight?: number;
  /** 次日本地零点的偏移;DST 切换日可能与 tzOffsetMinutes 不同。 */
  tzEndOffsetMinutes?: number;
}

/**
 * 临时房访客 chatToken 载荷:temp-chat 签发(LinkTokenService),chat 网关验签。
 * 定义放在 chat 侧是因为依赖方向是 TempChatModule → ChatModule,反向 import 成环。
 * kind 判别使它与分享链接 token 不可互换。
 */
export interface GuestChatTokenPayload {
  kind: typeof TEMP_CHAT_GUEST_TOKEN_KIND;
  guestId: string;
  tcId: string;
  conversationId: string;
}

/** 历史分页 DTO(REST GET /chat/conversations/:id/messages)。 */
export interface ChatHistoryPageDto {
  messages: ChatMessageDto[];
  /** 继续向前翻页的 beforeHeight;没有更早消息时为 null。 */
  nextBeforeHeight: number | null;
  /** afterHeight 增量补拉的续拉游标;已追平为 null(仅 afterHeight 查询返回)。 */
  nextAfterHeight?: number | null;
}

/**
 * GET /chat/messages/mutations 的响应:离线期间的撤回/编辑增量。
 *
 * 撤回不改 height,所以重连的 afterHeight 补拉结构上永远看不到它 ——
 * 这条通道按 max(revokedAt, editedAt) 的时间轴补。客户端拿 nextSince 当下一次
 * 的游标(截断时它停在本页最后一次变更上,而不是 serverTime),hasMore 为 true
 * 时应当立刻再拉一页,直到追平。
 */
export interface ChatMutationsPageDto {
  messages: ChatMessageDto[];
  /** 本次响应的服务端时刻。 */
  serverTime: string;
  /** 下一次请求应当传的 since。 */
  nextSince: string;
  /**
   * 与 nextSince 配对的 id 游标(复合 keyset)。
   * DateTime 只有毫秒精度:一批同毫秒的变更跨在页边界上时,只带时间戳的游标
   * 会把剩下那些同刻的行永久跳过。未截断时为空串。
   */
  nextSinceId: string;
  /** 还有没追完的变更(被单页上限截断)。 */
  hasMore: boolean;
  /**
   * 请求的 since 比服务端保留窗口(MUTATION_LOOKBACK_MS)还老 ——
   * 那段区间的变更已经查不到了。客户端必须丢掉本地消息缓存重新拉,
   * 否则那段时间里被撤回的消息会永远显示原文。
   */
  resetRequired: boolean;
}
