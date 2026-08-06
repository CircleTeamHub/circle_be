// 自研聊天的线上契约类型:socket 载荷 / ack / 广播 DTO。
// 与前端 src/chat-core/protocol.ts 镜像,字段名即协议,改动需两仓同步。
import type { AppErrorCode } from 'src/common/app-error-codes';

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
export interface ChatMessageDto {
  id: string;
  conversationId: string;
  height: number;
  type: string;
  content: Record<string, unknown>;
  sender: ChatSenderInfo | null;
  replyToId: string | null;
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
}

/** 历史分页 DTO(REST GET /chat/conversations/:id/messages)。 */
export interface ChatHistoryPageDto {
  messages: ChatMessageDto[];
  /** 继续向前翻页的 beforeHeight;没有更早消息时为 null。 */
  nextBeforeHeight: number | null;
}
