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
