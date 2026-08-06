import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { SensitiveWordService } from 'src/sensitive-word/sensitive-word.service';
import { ChatCircleSyncService } from './chat-circle-sync.service';
import { ChatMediaService } from './chat-media.service';
import type {
  ChatConversation,
  ChatMessage,
  Prisma,
} from 'src/generated/prisma';
import {
  CHAT_ADVISORY_LOCK_NS,
  CLIENT_MESSAGE_ID_MAX_LENGTH,
  CLIENT_MESSAGE_TYPES,
  CONVERSATION_LIST_MAX,
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  MAX_CONTENT_BYTES,
  MAX_TEXT_LENGTH,
} from './chat.constants';
import type {
  ChatConversationDto,
  ChatHistoryPageDto,
  ChatMessageDto,
  ChatSenderInfo,
  ChatSendPayload,
} from './chat.types';

interface SendResult {
  message: ChatMessageDto;
  reused: boolean;
}

type MessageRow = ChatMessage;

const CLIENT_TYPE_SET = new Set<string>(CLIENT_MESSAGE_TYPES);

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sensitiveWords: SensitiveWordService,
    private readonly circleSync: ChatCircleSyncService,
    private readonly media: ChatMediaService,
  ) {}

  /**
   * 发送校验:类型白名单、content 形状与体积、幂等键、敏感词。
   * socket 载荷不经过全局 ValidationPipe,必须在这里手动收口。
   */
  validateSendPayload(payload: ChatSendPayload): void {
    if (
      !payload ||
      typeof payload.conversationId !== 'string' ||
      payload.conversationId.length === 0 ||
      typeof payload.type !== 'string' ||
      typeof payload.d !== 'string' ||
      payload.d.length === 0 ||
      payload.d.length > CLIENT_MESSAGE_ID_MAX_LENGTH
    ) {
      throw new BadRequestException({
        message: '发送载荷不完整',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    if (!CLIENT_TYPE_SET.has(payload.type)) {
      // 'system' 等服务端专属类型也会落到这里:客户端不可伪造系统消息。
      throw new BadRequestException({
        message: `不支持的消息类型: ${payload.type}`,
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    if (
      payload.content === null ||
      typeof payload.content !== 'object' ||
      Array.isArray(payload.content)
    ) {
      throw new BadRequestException({
        message: 'content 必须是对象',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    if (
      Buffer.byteLength(JSON.stringify(payload.content), 'utf8') >
      MAX_CONTENT_BYTES
    ) {
      throw new BadRequestException({
        message: '消息体超限',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    if (
      payload.replyToId !== undefined &&
      typeof payload.replyToId !== 'string'
    ) {
      throw new BadRequestException({
        message: 'replyToId 非法',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    const text = payload.content['text'];
    if (text !== undefined) {
      if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) {
        throw new BadRequestException({
          message: '文本超限',
          errorCode: ChatErrorCode.InvalidPayload,
        });
      }
      const verdict = this.sensitiveWords.check(text);
      if (verdict.blocked) {
        throw new BadRequestException({
          message: '消息包含敏感词',
          errorCode: ChatErrorCode.SensitiveWord,
        });
      }
    }
  }

  /**
   * 发送消息(squady sendMsg 的移植):
   * 事务内 pg_advisory_xact_lock 串行化本会话 → clientMessageId 幂等查重 →
   * height = max+1 → 落库 → 更新会话 lastMessageAt。
   * 落库成功才返回,ack 语义 = 已持久化。
   */
  async sendMessage(
    senderUserId: string,
    payload: ChatSendPayload,
  ): Promise<SendResult> {
    this.validateSendPayload(payload);
    const conversation = await this.requireMembership(
      payload.conversationId,
      senderUserId,
    );
    if (conversation.type === 'DIRECT') {
      await this.assertDirectNotBlocked(conversation, senderUserId);
    }

    const content = payload.content as Prisma.InputJsonObject;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAT_ADVISORY_LOCK_NS}, hashtext(${payload.conversationId}))`;

      const existing = await tx.chatMessage.findUnique({
        where: {
          conversationID_senderID_clientMessageId: {
            conversationID: payload.conversationId,
            senderID: senderUserId,
            clientMessageId: payload.d,
          },
        },
      });
      if (existing) {
        return { row: existing, reused: true };
      }

      const maxHeight = await tx.chatMessage.aggregate({
        where: { conversationID: payload.conversationId },
        _max: { height: true },
      });
      const height = (maxHeight._max.height ?? 0) + 1;

      const row = await tx.chatMessage.create({
        data: {
          conversationID: payload.conversationId,
          height,
          senderID: senderUserId,
          type: payload.type,
          content,
          clientMessageId: payload.d,
          replyToID: payload.replyToId ?? null,
        },
      });
      await tx.chatConversation.update({
        where: { id: payload.conversationId },
        data: { lastMessageAt: row.createdAt },
      });
      return { row, reused: false };
    });

    const sender = await this.resolveSenders([senderUserId]);
    const message = this.toMessageDto(
      created.row,
      sender.get(senderUserId) ?? null,
    );
    // ack 与广播共用这份 DTO:媒体 key 在此签出 url(读路径,不落库)。
    await this.media.attachMediaUrls([message]);
    return { message, reused: created.reused };
  }

  /** 已读水位只前进不后退;返回是否发生了推进(未推进不必广播)。 */
  async markRead(
    userId: string,
    conversationId: string,
    height: number,
  ): Promise<boolean> {
    if (!Number.isInteger(height) || height < 0) {
      throw new BadRequestException({
        message: '已读水位非法',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    await this.requireMembership(conversationId, userId);
    const updated = await this.prisma.chatMember.updateMany({
      where: {
        conversationID: conversationId,
        userID: userId,
        lastReadHeight: { lt: height },
      },
      data: { lastReadHeight: height },
    });
    return updated.count > 0;
  }

  /** 连接建立时的房间派生:该用户所有在座会话的 id。 */
  async listConversationIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.chatMember.findMany({
      where: { userID: userId, leftAt: null },
      select: { conversationID: true },
    });
    return rows.map((r) => r.conversationID);
  }

  /** 会话列表:最近活跃前 N 个,带对端信息 / 末条消息 / 未读数。 */
  async listConversations(userId: string): Promise<ChatConversationDto[]> {
    const memberships = await this.prisma.chatMember.findMany({
      where: { userID: userId, leftAt: null },
      include: { conversation: true },
      orderBy: {
        conversation: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      },
      take: CONVERSATION_LIST_MAX,
    });
    if (memberships.length === 0) return [];

    const conversationIds = memberships.map((m) => m.conversationID);
    const directIds = memberships
      .filter((m) => m.conversation.type === 'DIRECT')
      .map((m) => m.conversationID);

    const [lastMessages, unreadCounts, peers] = await Promise.all([
      this.loadLastMessages(conversationIds),
      this.loadUnreadCounts(userId, memberships),
      this.loadDirectPeers(userId, directIds),
    ]);

    const senderIds = [...lastMessages.values()]
      .map((m) => m.senderID)
      .filter((id): id is string => id !== null);
    const senders = await this.resolveSenders(senderIds);

    const list = memberships.map((m) => {
      const last = lastMessages.get(m.conversationID) ?? null;
      return {
        id: m.conversationID,
        type: m.conversation.type,
        peer: peers.get(m.conversationID) ?? null,
        circleId: m.conversation.circleID,
        lastMessage: last
          ? this.toMessageDto(last, this.senderFor(last, senders))
          : null,
        unreadCount: unreadCounts.get(m.conversationID) ?? 0,
        pinned: m.pinned,
        muted: m.muted,
        lastMessageAt: m.conversation.lastMessageAt?.toISOString() ?? null,
      };
    });
    await this.media.attachMediaUrls(
      list
        .map((c) => c.lastMessage)
        .filter((m): m is ChatMessageDto => m !== null),
    );
    return list;
  }

  /**
   * 取或建圈子群会话:调用方必须是该圈 ACTIVE 成员。
   * ensure 幂等对齐座位(进圈后首次开聊即触发同步,不等对账周期)。
   */
  async getOrCreateCircleConversation(
    userId: string,
    circleId: string,
  ): Promise<ChatConversationDto> {
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: userId, circleID: circleId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException({
        message: '不是圈子成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    const conversationId =
      await this.circleSync.ensureCircleConversation(circleId);
    if (!conversationId) {
      throw new NotFoundException({
        message: '圈子不存在',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
    return this.buildConversationDto(userId, conversationId);
  }

  /** 会话偏好(置顶/免打扰):每成员独立,替代 OpenIM 的会话属性。 */
  async setConversationPreferences(
    userId: string,
    conversationId: string,
    prefs: { pinned?: boolean; muted?: boolean },
  ): Promise<ChatConversationDto> {
    await this.requireMembership(conversationId, userId);
    if (prefs.pinned !== undefined || prefs.muted !== undefined) {
      await this.prisma.chatMember.update({
        where: {
          conversationID_userID: {
            conversationID: conversationId,
            userID: userId,
          },
        },
        data: {
          ...(prefs.pinned !== undefined ? { pinned: prefs.pinned } : {}),
          ...(prefs.muted !== undefined ? { muted: prefs.muted } : {}),
        },
      });
    }
    return this.buildConversationDto(userId, conversationId);
  }

  /** 单会话 DTO(与 listConversations 同形):get-or-create / 偏好接口复用。 */
  private async buildConversationDto(
    userId: string,
    conversationId: string,
  ): Promise<ChatConversationDto> {
    const member = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: userId,
        },
      },
      include: { conversation: true },
    });
    if (!member || member.leftAt) {
      throw new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    const [lastMessages, unread, peers] = await Promise.all([
      this.loadLastMessages([conversationId]),
      this.loadUnreadCounts(userId, [
        {
          conversationID: conversationId,
          lastReadHeight: member.lastReadHeight,
        },
      ]),
      member.conversation.type === 'DIRECT'
        ? this.loadDirectPeers(userId, [conversationId])
        : Promise.resolve(new Map<string, ChatSenderInfo>()),
    ]);
    const last = lastMessages.get(conversationId) ?? null;
    let lastMessage: ChatMessageDto | null = null;
    if (last) {
      const senders = last.senderID
        ? await this.resolveSenders([last.senderID])
        : new Map<string, ChatSenderInfo>();
      lastMessage = this.toMessageDto(last, this.senderFor(last, senders));
      await this.media.attachMediaUrls([lastMessage]);
    }
    return {
      id: conversationId,
      type: member.conversation.type,
      peer: peers.get(conversationId) ?? null,
      circleId: member.conversation.circleID,
      lastMessage,
      unreadCount: unread.get(conversationId) ?? 0,
      pinned: member.pinned,
      muted: member.muted,
      lastMessageAt: member.conversation.lastMessageAt?.toISOString() ?? null,
    };
  }

  /** 历史分页:height 键集向前翻,页内升序返回。 */
  async getHistory(
    userId: string,
    conversationId: string,
    beforeHeight?: number,
    limit: number = HISTORY_PAGE_DEFAULT,
  ): Promise<ChatHistoryPageDto> {
    await this.requireMembership(conversationId, userId);
    const take = Math.min(Math.max(limit, 1), HISTORY_PAGE_MAX);
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationID: conversationId,
        deleted: false,
        ...(beforeHeight !== undefined ? { height: { lt: beforeHeight } } : {}),
      },
      orderBy: { height: 'desc' },
      take,
    });
    const senderIds = rows
      .map((r) => r.senderID)
      .filter((id): id is string => id !== null);
    const senders = await this.resolveSenders(senderIds);
    const ascending = [...rows].reverse();
    const messages = ascending.map((row) =>
      this.toMessageDto(row, this.senderFor(row, senders)),
    );
    await this.media.attachMediaUrls(messages);
    return {
      messages,
      nextBeforeHeight:
        rows.length === take ? rows[rows.length - 1].height : null,
    };
  }

  /**
   * 取或建单聊会话。directKey = 两个 userID 升序拼接,唯一约束防并发重建;
   * 撞唯一约束(P2002)说明对方先建成,重查取回即可。
   */
  async getOrCreateDirectConversation(
    userId: string,
    peerUserId: string,
  ): Promise<ChatConversationDto> {
    if (userId === peerUserId) {
      throw new BadRequestException({
        message: '不能和自己建会话',
        errorCode: ChatErrorCode.SelfConversation,
      });
    }
    const peer = await this.prisma.user.findUnique({
      where: { id: peerUserId },
      select: { id: true, nickname: true, avatarUrl: true, status: true },
    });
    if (!peer || peer.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: '对方不存在或不可用',
        errorCode: ChatErrorCode.PeerNotFound,
      });
    }
    await this.assertNotBlockedBetween(userId, peerUserId);

    // 码位序取小者在前:directKey 是唯一约束键,序必须与 locale 无关且永远稳定。
    const [low, high] =
      userId < peerUserId ? [userId, peerUserId] : [peerUserId, userId];
    const directKey = `${low}:${high}`;
    let conversation = await this.prisma.chatConversation.findUnique({
      where: { directKey },
      include: { members: true },
    });
    if (!conversation) {
      try {
        conversation = await this.prisma.chatConversation.create({
          data: {
            type: 'DIRECT',
            directKey,
            members: {
              create: [{ userID: userId }, { userID: peerUserId }],
            },
          },
          include: { members: true },
        });
      } catch (error) {
        if (!this.isUniqueViolation(error)) throw error;
        conversation = await this.prisma.chatConversation.findUnique({
          where: { directKey },
          include: { members: true },
        });
        if (!conversation) throw error;
      }
    }
    const conv = conversation;
    // 曾退出(leftAt 非空)则复位成员行 —— 单聊删除会话后再进入应恢复。
    const mine = conv.members.find((m) => m.userID === userId);
    if (mine?.leftAt) {
      await this.prisma.chatMember.update({
        where: { id: mine.id },
        data: { leftAt: null },
      });
    }

    const unread = mine
      ? await this.loadUnreadCounts(userId, [
          { conversationID: conv.id, lastReadHeight: mine.lastReadHeight },
        ])
      : new Map<string, number>();
    return {
      id: conv.id,
      type: conv.type,
      peer: { id: peer.id, nickname: peer.nickname, avatarUrl: peer.avatarUrl },
      circleId: null,
      lastMessage: null,
      unreadCount: unread.get(conv.id) ?? 0,
      pinned: mine?.pinned ?? false,
      muted: mine?.muted ?? false,
      lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
    };
  }

  /** 成员校验:会话存在且本人在座(未退出),返回会话行供类型分支使用。 */
  private async requireMembership(
    conversationId: string,
    userId: string,
  ): Promise<ChatConversation> {
    const member = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: userId,
        },
      },
      include: { conversation: true },
    });
    if (!member || member.leftAt) {
      throw new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    return member.conversation;
  }

  /** 单聊发送前的拉黑复查(任一方向拉黑即拒发)。 */
  private async assertDirectNotBlocked(
    conversation: ChatConversation,
    senderUserId: string,
  ): Promise<void> {
    const pair = conversation.directKey?.split(':') ?? [];
    const peerId = pair.find((id) => id !== senderUserId);
    if (!peerId) return;
    await this.assertNotBlockedBetween(senderUserId, peerId);
  }

  private async assertNotBlockedBetween(
    userA: string,
    userB: string,
  ): Promise<void> {
    const block = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerID: userA, blockedID: userB },
          { blockerID: userB, blockedID: userA },
        ],
      },
      select: { id: true },
    });
    if (block) {
      throw new ForbiddenException({
        message: '对方不可用',
        errorCode: ChatErrorCode.Blocked,
      });
    }
  }

  private async loadLastMessages(
    conversationIds: string[],
  ): Promise<Map<string, MessageRow>> {
    const rows = await Promise.all(
      conversationIds.map((id) =>
        this.prisma.chatMessage.findFirst({
          where: { conversationID: id, deleted: false },
          orderBy: { height: 'desc' },
        }),
      ),
    );
    const map = new Map<string, MessageRow>();
    rows.forEach((row) => {
      if (row) map.set(row.conversationID, row);
    });
    return map;
  }

  private async loadUnreadCounts(
    userId: string,
    memberships: Array<{ conversationID: string; lastReadHeight: number }>,
  ): Promise<Map<string, number>> {
    const counts = await Promise.all(
      memberships.map(async (m) => {
        const count = await this.prisma.chatMessage.count({
          where: {
            conversationID: m.conversationID,
            deleted: false,
            height: { gt: m.lastReadHeight },
            // 自己发的消息不计未读。
            NOT: { senderID: userId },
          },
        });
        return [m.conversationID, count] as const;
      }),
    );
    return new Map(counts);
  }

  /** DIRECT 会话的对端信息:conversationId → 对端用户。 */
  private async loadDirectPeers(
    userId: string,
    conversationIds: string[],
  ): Promise<Map<string, ChatSenderInfo>> {
    if (conversationIds.length === 0) return new Map();
    const others = await this.prisma.chatMember.findMany({
      where: {
        conversationID: { in: conversationIds },
        userID: { not: userId },
      },
      select: { conversationID: true, userID: true },
    });
    const users = await this.resolveSenders(others.map((o) => o.userID));
    const map = new Map<string, ChatSenderInfo>();
    others.forEach((o) => {
      const user = users.get(o.userID);
      if (user) map.set(o.conversationID, user);
    });
    return map;
  }

  private async resolveSenders(
    userIds: string[],
  ): Promise<Map<string, ChatSenderInfo>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, nickname: true, avatarUrl: true },
    });
    return new Map(
      users.map((u) => [
        u.id,
        { id: u.id, nickname: u.nickname, avatarUrl: u.avatarUrl },
      ]),
    );
  }

  private senderFor(
    row: MessageRow,
    senders: Map<string, ChatSenderInfo>,
  ): ChatSenderInfo | null {
    if (!row.senderID) return null;
    return senders.get(row.senderID) ?? null;
  }

  private toMessageDto(
    row: MessageRow,
    sender: ChatSenderInfo | null,
  ): ChatMessageDto {
    return {
      id: row.id,
      conversationId: row.conversationID,
      height: row.height,
      type: row.type,
      content: (row.content ?? {}) as Record<string, unknown>,
      sender,
      replyToId: row.replyToID,
      d: row.clientMessageId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
