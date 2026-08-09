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
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatCircleSyncService } from './chat-circle-sync.service';
import { ChatMediaService } from './chat-media.service';
import type {
  ChatConversation,
  ChatMessage,
  Prisma,
} from 'src/generated/prisma';
import {
  CHAT_ADVISORY_LOCK_NS,
  CHAT_MEDIA_KEY_PREFIX,
  CLIENT_MESSAGE_ID_MAX_LENGTH,
  CLIENT_MESSAGE_TYPES,
  CONVERSATION_LIST_MAX,
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  MAX_CONTENT_BYTES,
  MAX_TEXT_LENGTH,
  MEDIA_MESSAGE_TYPES,
} from './chat.constants';
import type {
  ChatConversationDto,
  ChatHistoryPageDto,
  ChatMemberDto,
  HistoryFilters,
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

/** 媒体 content 里只应持久化 object key;展示地址一律由读路径现签。 */
const MEDIA_PRESENTATION_FIELDS = ['url', 'thumbUrl', 'localUri'] as const;

function stripMediaPresentationFields(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...content };
  for (const field of MEDIA_PRESENTATION_FIELDS) delete cleaned[field];
  return cleaned;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sensitiveWords: SensitiveWordService,
    private readonly circleSync: ChatCircleSyncService,
    private readonly media: ChatMediaService,
    private readonly privacySettings: PrivacySettingsService,
    private readonly broadcast: ChatBroadcastService,
  ) {}

  /**
   * 发送校验:类型白名单、content 形状与体积、幂等键、敏感词。
   * socket 载荷不经过全局 ValidationPipe,必须在这里手动收口。
   */
  validateSendPayload(senderUserId: string, payload: ChatSendPayload): void {
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
      // 服务端专属类型(system / transfer-card / call-record / verification-card)
      // 也落到这里:它们断言的是已经发生过的服务端事实(钱已划走、通话已结束),
      // 客户端能发就等于能凭空捏造 —— 一张伪造的转账卡和真卡在收件人眼里毫无区别。
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
    // 媒体消息只收 object key,且必须是发送者自己的 chat/{senderId}/ 命名空间。
    // 拒 URL 形态是防「URL 固化进消息体」回潮(读路径统一由 ChatMediaService
    // 签发,见 docs/self-hosted-chat.md);绑命名空间是防拿到别人的 key
    // (例如从早期授权响应里学到的 notes/<别人>/...)后借聊天读路径无限续签,
    // 把已撤销授权的私有对象转手分发出去。
    if (MEDIA_MESSAGE_TYPES.includes(payload.type)) {
      const ownPrefix = `${CHAT_MEDIA_KEY_PREFIX}${senderUserId}/`;
      const isOwnKey = (value: unknown): boolean =>
        typeof value === 'string' &&
        value.startsWith(ownPrefix) &&
        value.length > ownPrefix.length &&
        !value.includes('://') &&
        !value.includes('..');
      const thumbKey = payload.content['thumbKey'];
      if (
        !isOwnKey(payload.content['key']) ||
        (thumbKey !== undefined && !isOwnKey(thumbKey))
      ) {
        throw new BadRequestException({
          message: '媒体消息必须携带你自己的 object key',
          errorCode: ChatErrorCode.InvalidPayload,
        });
      }
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
    this.validateSendPayload(senderUserId, payload);
    const conversation = await this.requireMembership(
      payload.conversationId,
      senderUserId,
    );
    if (conversation.type === 'DIRECT') {
      await this.assertDirectNotBlocked(conversation, senderUserId);
    }
    if (conversation.type === 'GROUP' && conversation.muteAllAt) {
      await this.assertNotMutedAll(conversation, senderUserId);
    }
    if (conversation.type === 'TEMP') {
      await this.assertTempChatActive(conversation);
    }

    // 媒体消息落库前剥掉展示字段。这些字段是读路径的产物(ChatMediaService
    // 按 key 现签),不是消息体的一部分 —— 留着的话:
    // 1) 客户端塞的 url/thumbUrl 会在签名失败(存储不可用)时原样存活并被渲染;
    // 2) localUri 本该只是发送方的本机路径,一旦被塞成 https://attacker/1x1.gif,
    //    每个滑过这条消息的人都会静默 GET 一次,把 IP 和已读时刻交给对方。
    // 客户端的本地预览应当只留在本地,不上行。
    const content = (
      MEDIA_MESSAGE_TYPES.includes(payload.type)
        ? stripMediaPresentationFields(payload.content)
        : payload.content
    ) as Prisma.InputJsonObject;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAT_ADVISORY_LOCK_NS}, hashtext(${payload.conversationId}))`;
      // 锁之后复查一遍。上面那几道是在锁外读的,和落库之间存在窗口:踢人、
      // 拉黑、管理台禁言、临时房到期都可能恰好落在这中间,消息照样写进去。
      // advisory lock 之后才是真正串行的位置,所以复查放在这里。
      await this.assertStillSendable(tx, payload.conversationId, senderUserId);

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
      // 新消息让所有成员的隐藏会话重新浮出(微信式语义)。
      await tx.chatMember.updateMany({
        where: {
          conversationID: payload.conversationId,
          hiddenAt: { not: null },
        },
        data: { hiddenAt: null },
      });
      return { row, reused: false };
    });

    // 事务已经提交 —— 这之后的一切都只是「把行装饰成 DTO」,绝不能因此抛错。
    //
    // 抛出去的后果不是"这次失败重试就好":handleSend 捕获后既不广播也不推送,
    // 而客户端拿同一个 d 重发时会命中幂等分支(reused=true),那条分支**刻意
    // 不广播**(首次投递时房间里已经收到过了 —— 但这次并没有)。于是一次瞬时的
    // 昵称查询失败,就让这条消息对所有收件人永久消失,数据库里却明明存着。
    //
    // 昵称/头像是装饰:取不到就发 sender=null,客户端仍有 senderID 可用。
    // 用降级换投递,而不是用投递换完整性。
    let sender: ChatSenderInfo | null = null;
    try {
      sender =
        (await this.resolveSenders([senderUserId])).get(senderUserId) ?? null;
    } catch (error) {
      this.logger.warn(
        `sender enrichment failed after commit message=${created.row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const message = this.toMessageDto(created.row, sender);
    // ack 与广播共用这份 DTO:媒体 key 在此签出 url(读路径,不落库)。
    // attachMediaUrls 自身已经把签名失败收敛成 warn,不会抛。
    await this.media.attachMediaUrls([message]);
    return { message, reused: created.reused };
  }

  /**
   * 已读水位只前进不后退。返回是否发生了推进(未推进不必广播)以及
   * 实际落库的高度 —— 广播必须用这个值,否则钳位之后仍会播出客户端报的假水位。
   */
  async markRead(
    userId: string,
    conversationId: string,
    height: number,
  ): Promise<{ advanced: boolean; height: number }> {
    if (!Number.isInteger(height) || height < 0) {
      throw new BadRequestException({
        message: '已读水位非法',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    await this.requireMembership(conversationId, userId);
    // 钳到会话当前最大 height:客户端可以报任意非负整数,直接落库的话
    // 一条 height=2e9 的 chat:read 会永久压掉后续所有未读,还会广播一条
    // 假的已读回执,直到会话真的涨到那个高度为止。
    const top = await this.prisma.chatMessage.aggregate({
      where: { conversationID: conversationId, deleted: false },
      _max: { height: true },
    });
    const ceiling = top._max.height ?? 0;
    const clamped = Math.min(height, ceiling);
    if (clamped <= 0) return { advanced: false, height: 0 };
    const updated = await this.prisma.chatMember.updateMany({
      where: {
        conversationID: conversationId,
        userID: userId,
        lastReadHeight: { lt: clamped },
      },
      data: { lastReadHeight: clamped },
    });
    return { advanced: updated.count > 0, height: clamped };
  }

  /**
   * 在线状态查询的可见范围:请求方与目标必须同处一个双方都在座的会话。
   * 返回请求列表里被允许的子集(自己始终可见)。
   */
  async filterVisiblePresenceTargets(
    userId: string,
    targetIds: string[],
  ): Promise<string[]> {
    const wanted = new Set(targetIds);
    const allowed = new Set<string>();
    if (wanted.delete(userId)) allowed.add(userId);
    if (wanted.size === 0) return [...allowed];

    const myConversationIds = await this.listConversationIds(userId);
    if (myConversationIds.length === 0) return [...allowed];
    const [shared, blocks] = await Promise.all([
      this.prisma.chatMember.findMany({
        where: {
          conversationID: { in: myConversationIds },
          userID: { in: [...wanted] },
          leftAt: null,
        },
        select: { userID: true },
        distinct: ['userID'],
      }),
      // 拉黑不动 ChatMember,座位照旧留着 —— 只按共享会话过滤的话,拉黑双方
      // 仍能互相看到在线状态。双向都排除:被拉黑方能看到对方在线同样是泄漏。
      this.prisma.block.findMany({
        where: {
          OR: [
            { blockerID: userId, blockedID: { in: [...wanted] } },
            { blockerID: { in: [...wanted] }, blockedID: userId },
          ],
        },
        select: { blockerID: true, blockedID: true },
      }),
    ]);
    const blocked = new Set(
      blocks.map((b) => (b.blockerID === userId ? b.blockedID : b.blockerID)),
    );
    for (const row of shared) {
      if (!blocked.has(row.userID)) allowed.add(row.userID);
    }
    return [...allowed];
  }

  /**
   * 与该用户存在拉黑关系的对端(双向)。
   *
   * 上下线广播要拿它把这些人从收件面里剔掉:拉黑不动 ChatMember,座位一直在,
   * 不剔的话拉黑双方会持续互相收到在线状态推送 —— 查询侧已经收口了
   * (filterVisiblePresenceTargets),广播侧不收口等于换个通道免费送同一份信息。
   */
  async listBlockedCounterparties(userId: string): Promise<string[]> {
    const rows = await this.prisma.block.findMany({
      where: { OR: [{ blockerID: userId }, { blockedID: userId }] },
      select: { blockerID: true, blockedID: true },
    });
    const out = new Set<string>();
    for (const row of rows) {
      out.add(row.blockerID === userId ? row.blockedID : row.blockerID);
    }
    return [...out];
  }

  /** 连接建立时的房间派生:该用户所有在座会话的 id。 */
  async listConversationIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.chatMember.findMany({
      where: { userID: userId, leftAt: null },
      select: { conversationID: true },
    });
    return rows.map((r) => r.conversationID);
  }

  /** 会话列表:最近活跃前 N 个,带对端信息 / 末条消息 / 未读数;隐藏的不出。 */
  async listConversations(userId: string): Promise<ChatConversationDto[]> {
    const memberships = await this.prisma.chatMember.findMany({
      where: { userID: userId, leftAt: null, hiddenAt: null },
      include: { conversation: true },
      // pinned 必须排在 take 之前参与排序。只按 lastMessageAt 取前 N 的话,
      // 置顶只是把已经取回来的这一页重排 —— 一个很久没说话的置顶会话会掉出
      // 前 N,在客户端彻底消失,而置顶的语义恰恰是「不管多久都要留在顶上」。
      orderBy: [
        { pinned: 'desc' },
        { conversation: { lastMessageAt: { sort: 'desc', nulls: 'last' } } },
      ],
      take: CONVERSATION_LIST_MAX,
    });
    if (memberships.length === 0) return [];

    const conversationIds = memberships.map((m) => m.conversationID);
    const directIds = memberships
      .filter((m) => m.conversation.type === 'DIRECT')
      .map((m) => m.conversationID);

    const [lastMessages, unreadCounts, peers, circles] = await Promise.all([
      this.loadLastMessages(conversationIds),
      this.loadUnreadCounts(userId, memberships),
      this.loadDirectPeers(userId, directIds),
      this.loadCircleInfos(
        memberships
          .map((m) => m.conversation.circleID)
          .filter((id): id is string => id !== null),
      ),
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
        circle: m.conversation.circleID
          ? (circles.get(m.conversation.circleID) ?? null)
          : null,
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

  /** 会话偏好(置顶/免打扰/隐藏):每成员独立,替代 OpenIM 的会话属性。 */
  async setConversationPreferences(
    userId: string,
    conversationId: string,
    prefs: { pinned?: boolean; muted?: boolean; hidden?: boolean },
  ): Promise<ChatConversationDto> {
    await this.requireMembership(conversationId, userId);
    if (
      prefs.pinned !== undefined ||
      prefs.muted !== undefined ||
      prefs.hidden !== undefined
    ) {
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
          // 隐藏是时间戳语义:新消息落库会整体清空(见 sendMessage)。
          ...(prefs.hidden !== undefined
            ? { hiddenAt: prefs.hidden ? new Date() : null }
            : {}),
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
    const circles = member.conversation.circleID
      ? await this.loadCircleInfos([member.conversation.circleID])
      : new Map<
          string,
          { id: string; name: string; avatarUrl: string | null }
        >();
    return {
      id: conversationId,
      type: member.conversation.type,
      peer: peers.get(conversationId) ?? null,
      circleId: member.conversation.circleID,
      circle: member.conversation.circleID
        ? (circles.get(member.conversation.circleID) ?? null)
        : null,
      lastMessage,
      unreadCount: unread.get(conversationId) ?? 0,
      pinned: member.pinned,
      muted: member.muted,
      lastMessageAt: member.conversation.lastMessageAt?.toISOString() ?? null,
    };
  }

  /**
   * 查看者自己的「消息自动销毁」截止时间。
   *
   * 这是每个用户对自己的设置(UserPrivacySetting.messageSelfDestructDays,
   * 默认 2 天):超过窗口的消息在**他自己的**客户端上不再出现。不是双方协商的
   * 阅后即焚,所以只按查看者过滤,不动库里的行。
   *
   * 返回 null 表示该用户关掉了自动销毁(0/未设置),不做任何过滤。
   */
  private async selfDestructCutoff(userId: string): Promise<Date | null> {
    const { messageSelfDestructDays } =
      await this.privacySettings.getSettings(userId);
    if (!messageSelfDestructDays) return null;
    return new Date(Date.now() - messageSelfDestructDays * 24 * 60 * 60 * 1000);
  }

  /** 历史分页:height 键集向前翻,页内升序返回。 */
  async getHistory(
    userId: string,
    conversationId: string,
    beforeHeight?: number,
    limit: number = HISTORY_PAGE_DEFAULT,
    filters: HistoryFilters = {},
    options: { applyViewerRetention?: boolean } = {},
  ): Promise<ChatHistoryPageDto> {
    await this.requireMembership(conversationId, userId);
    const take = Math.min(Math.max(limit, 1), HISTORY_PAGE_MAX);
    // 自动销毁窗口:拆栈前由 chat-history.service 负责,自研栈落地时漏掉了 ——
    // 设置在库里、UI 上也能改,但读取路径根本不看它,用户以为过期的消息其实
    // 一直在。收在 where 里而不是取回来再 filter:后者会让分页数不准。
    // 访客(临时房)没有 User 行,查隐私设置只会拿到 2 天的默认值 —— 而临时房
    // 本身可以开 3 天甚至 7 天,于是活着的房间里超过 2 天的消息对访客凭空消失,
    // 他还没有任何地方能改这个设置。访客的保留边界是房间寿命,不是用户偏好。
    const cutoff =
      options.applyViewerRetention === false
        ? null
        : await this.selfDestructCutoff(userId);
    const where: Prisma.ChatMessageWhereInput = {
      conversationID: conversationId,
      deleted: false,
      ...(beforeHeight !== undefined ? { height: { lt: beforeHeight } } : {}),
      ...this.buildHistoryFilterWhere(filters),
    };
    // 必须用 AND 追加,不能并进同一层 —— 按日期过滤同样写 createdAt,
    // 平铺展开会被它整个盖掉:客户端只要带上 date 参数就能翻出销毁窗口
    // 之外的消息,等于给这个设置留了个后门。
    if (cutoff) {
      where.AND = [{ createdAt: { gte: cutoff } }];
    }
    const rows = await this.prisma.chatMessage.findMany({
      where,
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
   * 历史过滤条件(聊天记录搜索/媒体/按日期共用):
   * keyword 走 jsonb path 包含(大小写敏感,CJK 主场景无损;拉丁小写化随
   * 后续全文索引批次);date 按客户端时区解释成当天 [00:00, 24:00) 的 UTC 区间。
   */
  private buildHistoryFilterWhere(
    filters: HistoryFilters,
  ): Prisma.ChatMessageWhereInput {
    const where: Prisma.ChatMessageWhereInput = {};
    if (filters.types?.length) {
      where.type = { in: filters.types };
    }
    if (filters.keyword) {
      where.content = { path: ['text'], string_contains: filters.keyword };
    }
    if (filters.date) {
      const tzOffset = filters.tzOffsetMinutes ?? 0;
      const start = Date.parse(`${filters.date}T00:00:00Z`) + tzOffset * 60_000;
      if (Number.isFinite(start)) {
        where.createdAt = {
          gte: new Date(start),
          lt: new Date(start + 24 * 60 * 60 * 1000),
        };
      }
    }
    return where;
  }

  /**
   * 某月内有聊天记录的日期集合('YYYY-MM-DD',按客户端时区归日),
   * 按日期日历给有记录的天上色用。上限 5000 行,极端活跃会话截断可接受。
   */
  async listMessageDays(
    userId: string,
    conversationId: string,
    year: number,
    month: number,
    tzOffsetMinutes = 0,
  ): Promise<string[]> {
    await this.requireMembership(conversationId, userId);
    const monthStart = Date.UTC(year, month, 1) + tzOffsetMinutes * 60_000;
    const monthEnd = Date.UTC(year, month + 1, 1) + tzOffsetMinutes * 60_000;
    if (!Number.isFinite(monthStart) || !Number.isFinite(monthEnd)) return [];
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationID: conversationId,
        deleted: false,
        createdAt: { gte: new Date(monthStart), lt: new Date(monthEnd) },
      },
      select: { createdAt: true },
      take: 5000,
    });
    const days = new Set<string>();
    for (const row of rows) {
      const local = new Date(
        row.createdAt.getTime() - tzOffsetMinutes * 60_000,
      );
      days.add(local.toISOString().slice(0, 10));
    }
    return [...days].sort((a, b) => (a < b ? -1 : 1));
  }

  /**
   * 全局搜索:跨本人全部在座会话搜文本(最新在前,扁平返回;
   * 会话展示信息由前端用自己的会话列表补,不在此放大查询)。
   */
  async searchAllMessages(
    userId: string,
    keyword: string,
    limit = 50,
  ): Promise<ChatMessageDto[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const memberships = await this.prisma.chatMember.findMany({
      where: { userID: userId, leftAt: null },
      select: { conversationID: true },
    });
    if (memberships.length === 0) return [];
    // 搜索必须和 getHistory 用同一把尺子:否则自动销毁窗口之外的消息
    // 在历史里看不到、一搜就出来了,等于开了后门。
    const cutoff = await this.selfDestructCutoff(userId);
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationID: { in: memberships.map((m) => m.conversationID) },
        deleted: false,
        type: { in: ['text', 'quote'] },
        content: { path: ['text'], string_contains: trimmed },
        ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), HISTORY_PAGE_MAX),
    });
    const senders = await this.resolveSenders(
      rows.map((r) => r.senderID).filter((id): id is string => id !== null),
    );
    return rows.map((row) =>
      this.toMessageDto(row, this.senderFor(row, senders)),
    );
  }

  /**
   * 取或建单聊会话。directKey = 两个 userID 升序拼接,唯一约束防并发重建;
   * 撞唯一约束(P2002)说明对方先建成,重查取回即可。
   */
  /**
   * 服务端结算类消息用的单聊会话解析 —— 只保证会话存在,不做交互授权。
   *
   * 拉黑与「接收陌生人消息」是给**用户主动发消息**设的闸。转账卡这类回执是
   * 钱已经结算之后由服务端补投的凭证:走交互路径的话,宽限期内对方随手一拉黑,
   * 补偿的每一次尝试都会抛错,打光重试次数后卡片永久丢失 —— 而钱已经划走了。
   * 收款人有权拿到自己那笔钱的凭证,这跟他愿不愿意继续聊天是两回事。
   *
   * 只给服务端补偿链路用,不要接到任何用户可直接触发的路径上。
   */
  async ensureDirectConversationForSettlement(
    userId: string,
    peerUserId: string,
  ): Promise<string> {
    const [low, high] =
      userId < peerUserId ? [userId, peerUserId] : [peerUserId, userId];
    const directKey = `${low}:${high}`;
    const existing = await this.prisma.chatConversation.findUnique({
      where: { directKey },
      select: { id: true },
    });
    if (existing) return existing.id;
    try {
      const created = await this.prisma.chatConversation.create({
        data: {
          type: 'DIRECT',
          directKey,
          members: { create: [{ userID: userId }, { userID: peerUserId }] },
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.chatConversation.findUnique({
        where: { directKey },
        select: { id: true },
      });
      if (!raced) throw error;
      return raced.id;
    }
  }

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
    // 首次建会话才过对方的「接收陌生人消息」开关 —— 与好友申请链路同一判定。
    // 只查拉黑是不够的:把开关关掉的用户仍会被任何知道其 UUID 的人直接开聊,
    // 建完会话就能立刻 socket 发消息。已有会话不复查:那是既存关系,
    // 事后改开关不该把历史会话锁死。
    if (!conversation) {
      const friends = await this.areFriends(userId, peerUserId);
      const allowed = await this.privacySettings.canReceiveStrangerMessage(
        peerUserId,
        friends,
      );
      if (!allowed) {
        throw new ForbiddenException({
          message: '对方不接收陌生人消息',
          errorCode: ChatErrorCode.StrangerNotAllowed,
        });
      }
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
    // 双方已在线的 socket 立刻入会话房:座位落库不会自动 join,不补这一步
    // 首条消息的广播就会漏掉在线的对端,推送分流还会把他当成离线用户。
    // 尽力而为,失败不阻断建会话(客户端重连时 handleConnection 会补上)。
    await Promise.all(
      [userId, peerUserId].map((memberId) =>
        this.broadcast
          .joinUserToConversation(memberId, conv.id)
          .catch((error: unknown) => {
            this.logger.warn(
              `join direct conversation room failed user=${memberId} conv=${conv.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }),
      ),
    );

    const [unread, lastMessage] = await Promise.all([
      mine
        ? this.loadUnreadCounts(userId, [
            { conversationID: conv.id, lastReadHeight: mine.lastReadHeight },
          ])
        : Promise.resolve(new Map<string, number>()),
      // 命中已有会话时必须回真实末条:客户端拿这个响应回填会话缓存,
      // 恒 null 会把已有会话的预览抹成空白,与 GET /chat/conversations 打架。
      this.loadLastMessageFor(conv.id),
    ]);
    return {
      id: conv.id,
      type: conv.type,
      peer: { id: peer.id, nickname: peer.nickname, avatarUrl: peer.avatarUrl },
      circleId: null,
      circle: null,
      lastMessage,
      unreadCount: unread.get(conv.id) ?? 0,
      pinned: mine?.pinned ?? false,
      muted: mine?.muted ?? false,
      lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
    };
  }

  /** 好友判定(任一方向的 ACCEPTED 行);陌生人消息开关按它放行。 */
  private async areFriends(
    userId: string,
    peerUserId: string,
  ): Promise<boolean> {
    const row = await this.prisma.friend.findFirst({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: userId, friendID: peerUserId },
          { userID: peerUserId, friendID: userId },
        ],
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** 单个会话的末条消息 DTO(带签名后的媒体 URL);无消息时 null。 */
  private async loadLastMessageFor(
    conversationId: string,
  ): Promise<ChatMessageDto | null> {
    const row = await this.prisma.chatMessage.findFirst({
      where: { conversationID: conversationId, deleted: false },
      orderBy: { height: 'desc' },
    });
    if (!row) return null;
    const senders = await this.resolveSenders(
      row.senderID ? [row.senderID] : [],
    );
    const dto = this.toMessageDto(row, this.senderFor(row, senders));
    await this.media.attachMediaUrls([dto]);
    return dto;
  }

  /** 会话成员目录:在座成员 + 用户展示信息;GROUP 会话附圈子角色。 */
  async listMembers(
    userId: string,
    conversationId: string,
  ): Promise<ChatMemberDto[]> {
    const conversation = await this.requireMembership(conversationId, userId);
    const seats = await this.prisma.chatMember.findMany({
      where: { conversationID: conversationId, leftAt: null },
      select: { userID: true },
    });
    const userIds = seats.map((s) => s.userID);
    const [users, roles] = await Promise.all([
      this.resolveSenders(userIds),
      conversation.circleID
        ? this.prisma.circleMember
            .findMany({
              where: { circleID: conversation.circleID, status: 'ACTIVE' },
              select: { userID: true, role: true },
            })
            .then((rows) => new Map(rows.map((r) => [r.userID, r.role])))
        : Promise.resolve(new Map<string, 'OWNER' | 'ADMIN' | 'MEMBER'>()),
    ]);
    return userIds
      .map((id) => {
        const user = users.get(id);
        if (!user) return null;
        return {
          userId: id,
          nickname: user.nickname,
          avatarUrl: user.avatarUrl,
          role: roles.get(id) ?? null,
        };
      })
      .filter((m): m is ChatMemberDto => m !== null);
  }

  /** 网关访客鉴权用:房间是否仍 ACTIVE 未过期。 */
  async getActiveTempChat(tempChatId: string): Promise<boolean> {
    const room = await this.prisma.tempChat.findUnique({
      where: { id: tempChatId },
      select: { status: true, expiresAt: true },
    });
    return room?.status === 'ACTIVE' && room.expiresAt.getTime() > Date.now();
  }

  /** 网关访客鉴权用:是否在座(未离座)。 */
  async hasSeat(conversationId: string, userId: string): Promise<boolean> {
    const seat = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: userId,
        },
      },
      select: { leftAt: true },
    });
    return Boolean(seat && !seat.leftAt);
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

  /** 管理台群禁言:全员禁言时仅圈主/管理员可发。 */
  private async assertNotMutedAll(
    conversation: ChatConversation,
    senderUserId: string,
  ): Promise<void> {
    if (!conversation.circleID) return;
    const membership = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: {
          userID: senderUserId,
          circleID: conversation.circleID,
        },
      },
      select: { role: true, status: true },
    });
    const exempt =
      membership?.status === 'ACTIVE' &&
      (membership.role === 'OWNER' || membership.role === 'ADMIN');
    if (!exempt) {
      throw new ForbiddenException({
        message: '该群已被禁言',
        errorCode: ChatErrorCode.ConversationMuted,
      });
    }
  }

  /** 临时房已结束/过期即拒发(访客凭证 TTL 之外的第二道闸)。 */
  private async assertTempChatActive(
    conversation: ChatConversation,
  ): Promise<void> {
    if (!conversation.tempChatID) return;
    const room = await this.prisma.tempChat.findUnique({
      where: { id: conversation.tempChatID },
      select: { status: true, expiresAt: true },
    });
    const active =
      room?.status === 'ACTIVE' && room.expiresAt.getTime() > Date.now();
    if (!active) {
      throw new ForbiddenException({
        message: '临时聊天已结束',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
  }

  /**
   * 发送事务内的最终复查 —— 与锁外那几道是同一组判定,只是换成事务客户端在
   * advisory lock 之后重跑一遍。
   *
   * 为什么值得重跑:锁外校验到落库之间是一个真实窗口,而这几种状态恰恰都是
   * 「别人可以在这一瞬改掉」的 —— 被踢出圈子(座位置 leftAt)、被对方拉黑、
   * 管理台按下禁言、临时房到期。窗口虽短,但踢人/封禁这类操作的语义就是
   * 「立刻生效」,让一条消息在生效之后还能挤进去,是把安全边界做成了概率问题。
   */
  private async assertStillSendable(
    tx: Prisma.TransactionClient,
    conversationId: string,
    senderUserId: string,
  ): Promise<void> {
    const seat = await tx.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: senderUserId,
        },
      },
      include: { conversation: true },
    });
    if (!seat || seat.leftAt) {
      throw new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    const conversation = seat.conversation;

    if (conversation.type === 'DIRECT') {
      const peerId = conversation.directKey
        ?.split(':')
        .find((id) => id !== senderUserId);
      if (peerId) {
        const block = await tx.block.findFirst({
          where: {
            OR: [
              { blockerID: senderUserId, blockedID: peerId },
              { blockerID: peerId, blockedID: senderUserId },
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
    }

    if (
      conversation.type === 'GROUP' &&
      conversation.muteAllAt &&
      conversation.circleID
    ) {
      const membership = await tx.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: senderUserId,
            circleID: conversation.circleID,
          },
        },
        select: { role: true, status: true },
      });
      const exempt =
        membership?.status === 'ACTIVE' &&
        (membership.role === 'OWNER' || membership.role === 'ADMIN');
      if (!exempt) {
        throw new ForbiddenException({
          message: '该群已被禁言',
          errorCode: ChatErrorCode.ConversationMuted,
        });
      }
    }

    if (conversation.type === 'TEMP' && conversation.tempChatID) {
      const room = await tx.tempChat.findUnique({
        where: { id: conversation.tempChatID },
        select: { status: true, expiresAt: true },
      });
      const active =
        room?.status === 'ACTIVE' && room.expiresAt.getTime() > Date.now();
      if (!active) {
        throw new ForbiddenException({
          message: '临时聊天已结束',
          errorCode: ChatErrorCode.ConversationNotFound,
        });
      }
    }
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

  /**
   * 每个会话的末条消息,一次集合查询取回。
   * 原来是每会话一次 findFirst:100 个会话的列表页就要 100 次往返,叠加
   * 未读计数共 ~201 次,正常用户打开会话列表就能把 Prisma 连接池吃干。
   * DISTINCT ON + (conversationID, height desc) 命中既有索引,单次即可。
   */
  private async loadLastMessages(
    conversationIds: string[],
  ): Promise<Map<string, MessageRow>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<MessageRow[]>`
      SELECT DISTINCT ON ("conversationID") *
      FROM "ChatMessage"
      WHERE "conversationID" = ANY(${conversationIds}::text[])
        AND "deleted" = false
      ORDER BY "conversationID", "height" DESC
    `;
    const map = new Map<string, MessageRow>();
    for (const row of rows) map.set(row.conversationID, row);
    return map;
  }

  /**
   * 每个会话的未读数,一次 GROUP BY 取回(每会话各自的 lastReadHeight 水位)。
   * 同上:原来每会话一次 count。
   */
  private async loadUnreadCounts(
    userId: string,
    memberships: Array<{ conversationID: string; lastReadHeight: number }>,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>(
      memberships.map((m) => [m.conversationID, 0]),
    );
    if (memberships.length === 0) return map;
    const ids = memberships.map((m) => m.conversationID);
    const floors = memberships.map((m) => m.lastReadHeight);
    const rows = await this.prisma.$queryRaw<
      Array<{ conversationID: string; count: bigint }>
    >`
      SELECT m."conversationID", COUNT(*)::bigint AS count
      FROM "ChatMessage" AS m
      JOIN unnest(${ids}::text[], ${floors}::int[]) AS w("conversationID", floor)
        ON w."conversationID" = m."conversationID"
      WHERE m."deleted" = false
        AND m."height" > w.floor
        -- 自己发的消息不计未读。
        AND (m."senderID" IS NULL OR m."senderID" <> ${userId})
      GROUP BY m."conversationID"
    `;
    for (const row of rows) map.set(row.conversationID, Number(row.count));
    return map;
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

  /** GROUP 会话的圈子展示信息(群名/群头像来源)。 */
  private async loadCircleInfos(
    circleIds: string[],
  ): Promise<
    Map<string, { id: string; name: string; avatarUrl: string | null }>
  > {
    const unique = [...new Set(circleIds)];
    if (unique.length === 0) return new Map();
    const circles = await this.prisma.circle.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, avatarUrl: true },
    });
    return new Map(
      circles.map((c) => [
        c.id,
        { id: c.id, name: c.name, avatarUrl: c.avatarUrl },
      ]),
    );
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
    const resolved = new Map<string, ChatSenderInfo>(
      users.map((u) => [
        u.id,
        { id: u.id, nickname: u.nickname, avatarUrl: u.avatarUrl },
      ]),
    );
    // 临时房访客不是 User 行:剩余 id 兜底查 TempChatGuest(展示名,无头像)。
    const missing = unique.filter((id) => !resolved.has(id));
    if (missing.length > 0) {
      const guests = await this.prisma.tempChatGuest.findMany({
        where: { imUserId: { in: missing } },
        select: { imUserId: true, displayName: true },
      });
      for (const guest of guests) {
        resolved.set(guest.imUserId, {
          id: guest.imUserId,
          nickname: guest.displayName,
          avatarUrl: null,
        });
      }
    }
    return resolved;
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
