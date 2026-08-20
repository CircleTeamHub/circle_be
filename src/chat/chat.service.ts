import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode, GroupErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { SensitiveWordService } from 'src/sensitive-word/sensitive-word.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { SupportService } from 'src/support/support.service';
import { lockUserRelationshipState } from 'src/utils/user-relationship-lock';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatSystemMessageService } from './chat-system-message.service';
import { ChatCircleSyncService } from './chat-circle-sync.service';
import { ChatMediaService } from './chat-media.service';
import type {
  ChatConversation,
  ChatMember,
  ChatMessage,
  Prisma,
} from 'src/generated/prisma';
import {
  CHAT_MEDIA_KEY_PREFIX,
  CHAT_NOTE_IMPORT_SEGMENT,
  CLIENT_MESSAGE_ID_MAX_LENGTH,
  CLIENT_MESSAGE_TYPES,
  CONVERSATION_LIST_MAX,
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  MAX_CONTENT_BYTES,
  MAX_TEXT_LENGTH,
  CHAT_EDIT_WINDOW_MS,
  CHAT_REACTION_EMOJIS,
  CHAT_REVOKE_WINDOW_MS,
  MEDIA_MESSAGE_TYPES,
  MUTATION_LOOKBACK_MS,
  MUTATION_PAGE_MAX,
  MUTATION_SAFETY_LAG_MS,
  READERS_PAGE_MAX,
  RELAX_PURGE_BATCH,
  RELAX_PURGE_BATCHES_MAX,
} from './chat.constants';
import type {
  ChatConversationDto,
  ChatHistoryPageDto,
  ChatMemberDto,
  ChatMutationsPageDto,
  HistoryFilters,
  ChatMessageDto,
  ChatSenderInfo,
  ChatSendPayload,
} from './chat.types';

interface SendResult {
  message: ChatMessageDto;
  reused: boolean;
}

/**
 * 读路径拿到的消息行。
 *
 * contentHistory(每次编辑压一版旧正文的审计数组)不在里面:它从不出现在
 * 任何 DTO 上,却会被 findMany 默认全取回来 —— 一页 100 条、几条被反复编辑过的
 * 长文本,就是几 MB 无人使用的 JSON 在热接口上来回搬运和解析。写路径要用它的
 * 地方(editMessage)单独把它读回来。
 */
type MessageRow = Omit<ChatMessage, 'contentHistory'>;
const MESSAGE_READ_OMIT = { contentHistory: true } as const;

// 独立群聊人数上限。好友邀请路径有好友数天然封顶,扫码进群放开了好友边界,
// 一张群码等于无限进人 —— 容量闸必须在服务端(微信同义:大群不再开放扫码)。
const STANDALONE_GROUP_MAX_MEMBERS = 200;

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
    private readonly systemMessage: ChatSystemMessageService,
    private readonly support: SupportService,
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
    if (
      payload.forwardFromMessageId !== undefined &&
      (typeof payload.forwardFromMessageId !== 'string' ||
        payload.forwardFromMessageId.length === 0 ||
        payload.forwardFromMessageId.length > CLIENT_MESSAGE_ID_MAX_LENGTH)
    ) {
      throw new BadRequestException({
        message: 'forwardFromMessageId 非法',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    // 媒体消息只收 object key,且必须是发送者自己的 chat/{senderId}/ 命名空间。
    // 拒 URL 形态是防「URL 固化进消息体」回潮(读路径统一由 ChatMediaService
    // 签发,见 docs/self-hosted-chat.md);绑命名空间是防拿到别人的 key
    // (例如从早期授权响应里学到的 notes/<别人>/...)后借聊天读路径无限续签,
    // 把已撤销授权的私有对象转手分发出去。
    if (
      MEDIA_MESSAGE_TYPES.includes(payload.type) &&
      payload.forwardFromMessageId === undefined
    ) {
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
    if (payload.type === 'qr-card') {
      const token = payload.content['token'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
        throw new BadRequestException({
          message: '二维码令牌非法',
          errorCode: ChatErrorCode.InvalidPayload,
        });
      }
    }
    // quotedText 与 text 同等对待。
    //
    // 它是客户端塞的「被引用消息原文」快照,在引用目标已被物删时作为兜底展示 ——
    // 也就是说它会原样落库、原样广播。只检 text 的话:发一条 type='quote'、
    // text 无害、replyToId 指向一条不存在的消息(于是归属校验把引用降级成 null)、
    // 把违禁内容全塞进 quotedText —— 敏感词检查一个字都看不到。
    for (const field of ['text', 'quotedText']) {
      const value = payload.content[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) {
        throw new BadRequestException({
          message: '文本超限',
          errorCode: ChatErrorCode.InvalidPayload,
        });
      }
      const verdict = this.sensitiveWords.check(value);
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
    if (payload.forwardFromMessageId) {
      const existing = await this.prisma.chatMessage.findFirst({
        where: {
          conversationID: payload.conversationId,
          senderID: senderUserId,
          clientMessageId: payload.d,
        },
      });
      if (existing) {
        return this.presentSentMessage(existing, senderUserId, true);
      }
    }
    let effectivePayload = payload;
    let copiedKeys: string[] = [];
    try {
      if (payload.forwardFromMessageId) {
        const source = await this.resolveForwardableMedia(
          senderUserId,
          payload.forwardFromMessageId,
        );
        const copied = await this.media.copyForForward(
          source.type,
          source.content,
          senderUserId,
        );
        copiedKeys = copied.copiedKeys;
        effectivePayload = {
          conversationId: payload.conversationId,
          type: source.type,
          content: copied.content,
          d: payload.d,
          // 被源消息接管的只有 type/content;引用是本次发送自己的意图,
          // 漏掉它等于静默丢掉客户端明确发上来的 replyToId。
          ...(payload.replyToId !== undefined
            ? { replyToId: payload.replyToId }
            : {}),
        };
        this.validateSendPayload(senderUserId, effectivePayload);
      }
      // G-09 真引用的归属校验。replyToId 之前只校验「是个字符串」,于是任何人都能
      // 拿一条**别的会话**里的消息 UUID 当引用发出去 —— attachReplyTo 照单全收,
      // 把那条消息的发送者昵称、类型和文本摘要广播进当前房间。退群的人手里留着
      // 旧 UUID 同样能这么捞。放在事务外做:被引用消息不会换会话,没有 TOCTOU。
      const replyToId = await this.resolveReplyTarget(
        effectivePayload.conversationId,
        effectivePayload.replyToId,
      );

      // 媒体消息落库前剥掉展示字段。这些字段是读路径的产物(ChatMediaService
      // 按 key 现签),不是消息体的一部分 —— 留着的话:
      // 1) 客户端塞的 url/thumbUrl 会在签名失败(存储不可用)时原样存活并被渲染;
      // 2) localUri 本该只是发送方的本机路径,一旦被塞成 https://attacker/1x1.gif,
      //    每个滑过这条消息的人都会静默 GET 一次,把 IP 和已读时刻交给对方。
      // 客户端的本地预览应当只留在本地,不上行。
      const content = (
        MEDIA_MESSAGE_TYPES.includes(effectivePayload.type)
          ? stripMediaPresentationFields(effectivePayload.content)
          : effectivePayload.content
      ) as Prisma.InputJsonObject;
      const created = await this.prisma.$transaction(async (tx) => {
        // G-05:会话行锁替 advisory lock —— 同会话串行,跨会话零互扰
        // (hashtext 碰撞让无关会话互等的问题消失),也不再做 MAX(height) 聚合扫描。
        const counter = await tx.$queryRaw<Array<{ nextHeight: number }>>`
        SELECT "nextHeight" FROM "ChatConversation"
        WHERE "id" = ${effectivePayload.conversationId} FOR UPDATE`;
        if (counter.length === 0) {
          throw new NotFoundException({
            message: '会话不存在',
            errorCode: ChatErrorCode.ConversationNotFound,
          });
        }
        // 锁之后复查一遍。上面那几道是在锁外读的,和落库之间存在窗口:踢人、
        // 拉黑、管理台禁言、临时房到期都可能恰好落在这中间,消息照样写进去。
        // 行锁之后才是真正串行的位置,所以复查放在这里 —— 且在取号之前,
        // 被拒绝的发送不推进计数器,height 无空洞。
        await this.assertStillSendable(
          tx,
          effectivePayload.conversationId,
          senderUserId,
        );

        const existing = await tx.chatMessage.findUnique({
          where: {
            conversationID_senderID_clientMessageId: {
              conversationID: effectivePayload.conversationId,
              senderID: senderUserId,
              clientMessageId: effectivePayload.d,
            },
          },
        });
        if (existing) {
          return { row: existing, reused: true };
        }

        const height = counter[0].nextHeight + 1;

        const row = await tx.chatMessage.create({
          data: {
            conversationID: effectivePayload.conversationId,
            height,
            senderID: senderUserId,
            type: effectivePayload.type,
            content,
            clientMessageId: effectivePayload.d,
            replyToID: replyToId,
          },
        });
        if (copiedKeys.length > 0) {
          const claimed = await tx.chatMediaDeletion.deleteMany({
            where: { objectKey: { in: copiedKeys } },
          });
          if (claimed.count !== copiedKeys.length) {
            throw new Error('Forward media reservation claim mismatch');
          }
        }
        // 计数器前进与会话排序时间合并成一条 UPDATE(临界区少一次往返)。
        await tx.chatConversation.update({
          where: { id: effectivePayload.conversationId },
          data: { nextHeight: height, lastMessageAt: row.createdAt },
        });
        // 新消息让所有成员的隐藏会话重新浮出(微信式语义)。
        await tx.chatMember.updateMany({
          where: {
            conversationID: effectivePayload.conversationId,
            hiddenAt: { not: null },
          },
          data: { hiddenAt: null },
        });
        return { row, reused: false };
      });

      // 提交完成的那一刻就把复制出来的对象交割掉。继续留在 copiedKeys 里的话,
      // 提交之后任何一次抛错都会走到下面的 catch,把一条**已经落库**的消息所
      // 引用的媒体删掉 —— 行还在,图永远打不开。
      const orphanedCopies = copiedKeys;
      copiedKeys = [];
      if (created.reused && orphanedCopies.length > 0) {
        // 幂等重放:库里那条引用的是首次复制出来的 key,这一轮复制的是孤儿。
        // 清不掉只是留下垃圾对象,不该让一条已落库的消息投递失败。
        try {
          await this.media.deleteObjects(orphanedCopies);
        } catch (error) {
          this.logger.warn(
            `forward copy cleanup failed message=${created.row.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      return this.presentSentMessage(created.row, senderUserId, created.reused);
    } catch (error) {
      if (copiedKeys.length > 0) await this.media.deleteObjects(copiedKeys);
      throw error;
    }
  }

  /** 把已提交消息装饰成发送结果；装饰失败绝不能反转持久化成功。 */
  private async presentSentMessage(
    row: MessageRow,
    senderUserId: string,
    reused: boolean,
  ): Promise<SendResult> {
    let sender: ChatSenderInfo | null = null;
    try {
      sender =
        (await this.resolveSenders([senderUserId])).get(senderUserId) ?? null;
    } catch (error) {
      this.logger.warn(
        `sender enrichment failed after commit message=${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const message = this.toMessageDto(row, sender);
    try {
      await this.attachReplyTo([message]);
    } catch (error) {
      this.logger.warn(
        `reply enrichment failed after commit message=${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.media.attachMediaUrls([message]);
    return { message, reused };
  }

  private async resolveForwardableMedia(
    userId: string,
    messageId: string,
  ): Promise<{ type: string; content: Record<string, unknown> }> {
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      omit: MESSAGE_READ_OMIT,
    });
    if (
      !row ||
      row.deleted ||
      row.revokedAt ||
      !MEDIA_MESSAGE_TYPES.includes(row.type)
    ) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    const { conversation, member } = await this.requireMembershipSeat(
      row.conversationID,
      userId,
    );
    // 可见性只回答「你现在能不能看见」,回答不了「你能不能让别人永远看见」。
    // 阅后即焚会话的短暂性是**发送者对收件人的承诺**:把别人发的对象复制进一个
    // 没有 burn 的会话,等于绕开那条承诺把它永久化,副本还活得比源消息久。
    //
    // 自己发的除外。那是你自己的内容、key 本来就在你自己的命名空间里,你打开
    // 相册重发一次效果完全一样 —— 拦下来不保护任何人,只是让你多走一步。
    if (conversation.burnDurationSec && row.senderID !== userId) {
      throw new ForbiddenException({
        message: '阅后即焚会话中的消息不可转发',
        errorCode: ChatErrorCode.ForwardForbidden,
      });
    }
    // burn 会话现在还能走到这儿(自己发的),所以烧毁水位必须重新参与判定 ——
    // 否则「自己的」这个口子会顺带放行自己早就烧掉的消息。
    const viewerCutoff = await this.selfDestructCutoff(userId);
    const burnCutoff = conversation.burnDurationSec
      ? new Date(Date.now() - conversation.burnDurationSec * 1000)
      : null;
    const cutoff = this.strictestCutoff(viewerCutoff, burnCutoff);
    if (
      row.height <= (member.clearedBeforeHeight ?? 0) ||
      (cutoff !== null && row.createdAt < cutoff)
    ) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    const content = row.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    return { type: row.type, content: content as Record<string, unknown> };
  }

  /**
   * 引用目标解析:只认**本会话**里仍存在的消息。
   *
   * - 找不到 / 已物删(焚毁、清理):返回 null,降级成客户端的 quotedText 文本
   *   快照,不拒发 —— 这是正常的时序,不是攻击。
   * - 存在但属于别的会话:拒发。这条路径没有任何正当用法,放过去就是跨会话读。
   */
  private async resolveReplyTarget(
    conversationId: string,
    replyToId: string | null | undefined,
  ): Promise<string | null> {
    if (typeof replyToId !== 'string' || replyToId.length === 0) return null;
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: replyToId },
      select: { conversationID: true, deleted: true },
    });
    if (!row || row.deleted) return null;
    if (row.conversationID !== conversationId) {
      throw new ForbiddenException({
        message: '引用的消息不属于该会话',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    return replyToId;
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
    const viewerCutoff = await this.selfDestructCutoff(userId);
    const cutoffs = memberships.map((m) => {
      const seconds = m.conversation.burnDurationSec;
      const burnCutoff = seconds ? new Date(Date.now() - seconds * 1000) : null;
      return this.strictestCutoff(viewerCutoff, burnCutoff);
    });

    const [lastMessages, unreadCounts, peers, circles, tempChats] =
      await Promise.all([
        this.loadLastMessages(conversationIds, cutoffs),
        this.loadUnreadCounts(
          userId,
          // G-14:未读底数取已读水位与清空水位的更高者,清空过的段落不再计数。
          memberships.map((m) => ({
            conversationID: m.conversationID,
            lastReadHeight: Math.max(
              m.lastReadHeight,
              m.clearedBeforeHeight ?? 0,
            ),
          })),
          cutoffs,
        ),
        this.loadDirectPeers(userId, directIds),
        this.loadCircleInfos(
          memberships
            .map((m) => m.conversation.circleID)
            .filter((id): id is string => id !== null),
        ),
        this.loadTempChatInfos(
          memberships
            .map((m) => m.conversation.tempChatID)
            .filter((id): id is string => id !== null),
        ),
      ]);

    const senderIds = [...lastMessages.values()]
      .map((m) => m.senderID)
      .filter((id): id is string => id !== null);
    const senders = await this.resolveSenders(senderIds);

    const list = memberships.map((m) => {
      const rawLast = lastMessages.get(m.conversationID) ?? null;
      // 清空水位之下的末条不给本人当预览:清空过的会话看起来就是空的。
      const last =
        rawLast && rawLast.height <= (m.clearedBeforeHeight ?? 0)
          ? null
          : rawLast;
      return {
        id: m.conversationID,
        type: m.conversation.type,
        peer: peers.get(m.conversationID) ?? null,
        circleId: m.conversation.circleID,
        circle: m.conversation.circleID
          ? (circles.get(m.conversation.circleID) ?? null)
          : null,
        name: m.conversation.name ?? null,
        ownerId: m.conversation.ownerID ?? null,
        tempChat: m.conversation.tempChatID
          ? (tempChats.get(m.conversation.tempChatID) ?? null)
          : null,
        lastMessage: last
          ? this.toMessageDto(last, this.senderFor(last, senders))
          : null,
        unreadCount: unreadCounts.get(m.conversationID) ?? 0,
        pinned: m.pinned,
        muted: m.muted,
        burnDurationSec: m.conversation.burnDurationSec ?? null,
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

  /**
   * 独立群聊(微信群语义):不挂圈子,成员即 ChatMember 行,建群人是群主。
   * 只能拉自己的好友 —— 与单聊的陌生人开关同一信任边界:UUID 不是授权。
   */
  async createGroupConversation(
    userId: string,
    input: { name?: string | null; memberIds: string[] },
  ): Promise<ChatConversationDto> {
    const memberIds = [...new Set(input.memberIds)].filter(
      (id) => id !== userId,
    );
    if (memberIds.length < 2) {
      throw new BadRequestException({
        message: '至少选择 2 位好友',
        errorCode: ChatErrorCode.GroupMinMembers,
      });
    }
    if (memberIds.length + 1 > STANDALONE_GROUP_MAX_MEMBERS) {
      throw new ConflictException({
        message: '群聊人数已达上限',
        errorCode: ChatErrorCode.GroupFull,
      });
    }
    const name = input.name?.trim() || null;
    const conversation = await this.prisma.$transaction(async (tx) => {
      await lockUserRelationshipState(tx, [userId, ...memberIds]);
      await this.assertInviteTargetsAllowed(tx, userId, memberIds);
      const activeCount = await tx.user.count({
        where: { id: { in: memberIds }, status: 'ACTIVE' },
      });
      if (activeCount !== memberIds.length) {
        throw new NotFoundException({
          message: '部分成员不存在或不可用',
          errorCode: ChatErrorCode.PeerNotFound,
        });
      }
      return tx.chatConversation.create({
        data: {
          type: 'GROUP',
          name,
          ownerID: userId,
          members: {
            create: [userId, ...memberIds].map((id) => ({ userID: id })),
          },
        },
        select: { id: true },
      });
    });
    await this.seatMembersIntoRoom(conversation.id, [userId, ...memberIds]);
    // 建群提示一条就够;成员名单首屏可见,不再逐人刷「加入群聊」。
    void this.systemMessage
      .emit(conversation.id, { kind: 'group-created' })
      .catch(() => undefined);
    return this.buildConversationDto(userId, conversation.id);
  }

  /** 独立群聊邀请:任一在座成员可拉自己的好友(微信语义);圈子群走圈子成员管理。 */
  async inviteToGroupConversation(
    userId: string,
    conversationId: string,
    memberIds: string[],
  ): Promise<ChatConversationDto> {
    const conversation = await this.requireStandaloneGroup(
      conversationId,
      userId,
    );
    const invitees = [...new Set(memberIds)].filter((id) => id !== userId);
    if (invitees.length === 0) {
      throw new BadRequestException({
        message: '未选择邀请对象',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    const toJoin = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; type: string; circleID: string | null }>
      >`SELECT "id", "type", "circleID" FROM "ChatConversation"
        WHERE "id" = ${conversation.id} FOR UPDATE`;
      if (
        locked.length === 0 ||
        locked[0].type !== 'GROUP' ||
        locked[0].circleID !== null
      ) {
        throw new NotFoundException({
          message: '群聊不存在',
          errorCode: ChatErrorCode.ConversationNotFound,
        });
      }
      await lockUserRelationshipState(tx, [userId, ...invitees]);
      const actorSeat = await tx.chatMember.findUnique({
        where: {
          conversationID_userID: {
            conversationID: conversation.id,
            userID: userId,
          },
        },
        select: { leftAt: true },
      });
      if (!actorSeat || actorSeat.leftAt) {
        throw new ForbiddenException({
          message: '不是会话成员',
          errorCode: ChatErrorCode.NotMember,
        });
      }
      await this.assertInviteTargetsAllowed(tx, userId, invitees);
      const seats = await tx.chatMember.findMany({
        where: { conversationID: conversation.id, userID: { in: invitees } },
        select: { id: true, userID: true, leftAt: true },
      });
      const seated = new Map(seats.map((seat) => [seat.userID, seat]));
      const joining = invitees.filter((id) => {
        const seat = seated.get(id);
        return !seat || seat.leftAt !== null;
      });
      if (joining.length === 0) return joining;
      const seatedCount = await tx.chatMember.count({
        where: { conversationID: conversation.id, leftAt: null },
      });
      if (seatedCount + joining.length > STANDALONE_GROUP_MAX_MEMBERS) {
        throw new ConflictException({
          message: '群聊人数已达上限',
          errorCode: ChatErrorCode.GroupFull,
        });
      }
      for (const id of joining) {
        const seat = seated.get(id);
        if (seat) {
          // 退过群的好友重新拉回:复位座位并抬清空水位,退群前的历史不回放。
          const top = await tx.chatMessage.aggregate({
            where: { conversationID: conversation.id, deleted: false },
            _max: { height: true },
          });
          await tx.chatMember.update({
            where: { id: seat.id },
            data: {
              leftAt: null,
              joinedAt: new Date(),
              clearedBeforeHeight: top._max.height ?? 0,
            },
          });
        } else {
          await tx.chatMember.create({
            data: { conversationID: conversation.id, userID: id },
          });
        }
      }
      return joining;
    });
    if (toJoin.length === 0) {
      return this.buildConversationDto(userId, conversation.id);
    }
    await this.seatMembersIntoRoom(conversation.id, toJoin);
    void this.emitGroupJoinNotice(conversation.id, toJoin);
    return this.buildConversationDto(userId, conversation.id);
  }

  /**
   * 扫码进群(独立群聊):QrService 已验过令牌,令牌即授权 —— 不要求与在座成员
   * 是好友,群二维码本来就是递给陌生人的(微信语义)。幂等:已在座直接返回。
   */
  async joinStandaloneGroupViaQr(
    userId: string,
    conversationId: string,
  ): Promise<ChatConversationDto> {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, type: true, circleID: true },
    });
    if (
      !conversation ||
      conversation.type !== 'GROUP' ||
      conversation.circleID
    ) {
      throw new NotFoundException({
        message: '群聊不存在',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
    const joined = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string; type: string; circleID: string | null }>
      >`SELECT "id", "type", "circleID" FROM "ChatConversation"
        WHERE "id" = ${conversationId} FOR UPDATE`;
      if (
        locked.length === 0 ||
        locked[0].type !== 'GROUP' ||
        locked[0].circleID !== null
      ) {
        throw new NotFoundException({
          message: '群聊不存在',
          errorCode: ChatErrorCode.ConversationNotFound,
        });
      }
      const existing = await tx.chatMember.findFirst({
        where: { conversationID: conversationId, userID: userId },
        select: { id: true, leftAt: true },
      });
      if (existing && existing.leftAt === null) return false;
      const seated = await tx.chatMember.count({
        where: { conversationID: conversationId, leftAt: null },
      });
      // 全员退光的死群,码不再开门 —— 扫进去只会得到一间没人的空房。
      if (seated === 0) {
        throw new NotFoundException({
          message: '群聊不存在',
          errorCode: ChatErrorCode.ConversationNotFound,
        });
      }
      if (seated >= STANDALONE_GROUP_MAX_MEMBERS) {
        throw new ConflictException({
          message: '群聊人数已达上限',
          errorCode: ChatErrorCode.GroupFull,
        });
      }
      if (existing) {
        // 退过群又扫码回来:复位座位并抬清空水位,退群前的历史不回放
        // (与好友邀请路径同一语义)。
        const top = await tx.chatMessage.aggregate({
          where: { conversationID: conversationId, deleted: false },
          _max: { height: true },
        });
        await tx.chatMember.update({
          where: { id: existing.id },
          data: {
            leftAt: null,
            joinedAt: new Date(),
            clearedBeforeHeight: top._max.height ?? 0,
          },
        });
      } else {
        await tx.chatMember.create({
          data: { conversationID: conversationId, userID: userId },
        });
      }
      return true;
    });
    if (!joined) return this.buildConversationDto(userId, conversationId);
    await this.seatMembersIntoRoom(conversationId, [userId]);
    void this.emitGroupJoinNotice(conversationId, [userId]);
    return this.buildConversationDto(userId, conversationId);
  }

  /** 独立群聊退群:座位置 leftAt;群主退群转给最早入群的在座成员。 */
  async leaveGroupConversation(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.requireStandaloneGroup(
      conversationId,
      userId,
    );
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          type: string;
          circleID: string | null;
          ownerID: string | null;
        }>
      >`SELECT "id", "type", "circleID", "ownerID" FROM "ChatConversation"
        WHERE "id" = ${conversation.id} FOR UPDATE`;
      if (
        locked.length === 0 ||
        locked[0].type !== 'GROUP' ||
        locked[0].circleID !== null
      ) {
        throw new NotFoundException({
          message: '群聊不存在',
          errorCode: ChatErrorCode.ConversationNotFound,
        });
      }
      const actorSeat = await tx.chatMember.findUnique({
        where: {
          conversationID_userID: {
            conversationID: conversation.id,
            userID: userId,
          },
        },
        select: { leftAt: true },
      });
      if (!actorSeat || actorSeat.leftAt) {
        throw new ForbiddenException({
          message: '不是会话成员',
          errorCode: ChatErrorCode.NotMember,
        });
      }
      await tx.chatMember.updateMany({
        where: {
          conversationID: conversation.id,
          userID: userId,
          leftAt: null,
        },
        data: { leftAt: new Date() },
      });
      if (locked[0].ownerID === userId) {
        const successor = await tx.chatMember.findFirst({
          where: { conversationID: conversation.id, leftAt: null },
          orderBy: { joinedAt: 'asc' },
          select: { userID: true },
        });
        // 最后一人退群:群主字段留着(会话已无在座成员,等价于死会话)。
        if (successor) {
          await tx.chatConversation.update({
            where: { id: conversation.id },
            data: { ownerID: successor.userID },
          });
        }
      }
    });
    void this.broadcast
      .removeUserFromConversation(userId, conversation.id)
      .catch(() => undefined);
    this.broadcast.emitConversationChange(userId, {
      kind: 'left',
      conversationId: conversation.id,
      userId,
    });
    void this.systemMessage
      .emit(conversation.id, { kind: 'member-left' })
      .catch(() => undefined);
  }

  /** 独立群聊改名:任一在座成员可改(微信语义);改完发系统提示留痕。 */
  async renameGroupConversation(
    userId: string,
    conversationId: string,
    name: string,
  ): Promise<ChatConversationDto> {
    const conversation = await this.requireStandaloneGroup(
      conversationId,
      userId,
    );
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException({
        message: '群名不能为空',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    await this.prisma.chatConversation.update({
      where: { id: conversation.id },
      data: { name: trimmed },
    });
    void this.systemMessage
      .emit(conversation.id, { kind: 'group-renamed', name: trimmed })
      .catch(() => undefined);
    return this.buildConversationDto(userId, conversation.id);
  }

  /** 独立群聊专属操作的共同门:必须是在座成员,且会话是不挂圈子的 GROUP。 */
  private async requireStandaloneGroup(
    conversationId: string,
    userId: string,
  ): Promise<ChatConversation> {
    const conversation = await this.requireMembership(conversationId, userId);
    if (conversation.type !== 'GROUP' || conversation.circleID) {
      throw new ForbiddenException({
        message: '该群由圈子管理',
        errorCode: ChatErrorCode.GroupCircleManaged,
      });
    }
    return conversation;
  }

  /**
   * 独立群邀请的共同授权边界:目标仍是好友,且其群邀请隐私允许当前关系。
   * 调用方必须先拿 call-user 关系锁,这样好友/隐私切换不能在检查与落座之间穿插。
   */
  private async assertInviteTargetsAllowed(
    tx: Prisma.TransactionClient,
    userId: string,
    memberIds: string[],
  ): Promise<void> {
    const [rows, privacyRows] = await Promise.all([
      tx.friend.findMany({
        where: {
          state: 'ACCEPTED',
          OR: [
            { userID: userId, friendID: { in: memberIds } },
            { friendID: userId, userID: { in: memberIds } },
          ],
        },
        select: { userID: true, friendID: true },
      }),
      tx.userPrivacySetting.findMany({
        where: { userID: { in: memberIds } },
        select: { userID: true, groupInvitePermission: true },
      }),
    ]);
    const friendIds = new Set(
      rows.map((r) => (r.userID === userId ? r.friendID : r.userID)),
    );
    if (memberIds.some((id) => !friendIds.has(id))) {
      throw new ForbiddenException({
        message: '只能邀请好友进群',
        errorCode: ChatErrorCode.GroupFriendsOnly,
      });
    }
    const permissions = new Map(
      privacyRows.map((row) => [row.userID, row.groupInvitePermission]),
    );
    if (
      memberIds.some((id) => {
        const permission = permissions.get(id) ?? 'EVERYONE';
        return (
          permission === 'NONE' ||
          (permission === 'FRIENDS_ONLY' && !friendIds.has(id))
        );
      })
    ) {
      throw new ForbiddenException({
        message: '对方不允许群邀请',
        // 好友校验上面已经过了,这里被拒的都是"是好友但关了群邀请"。复用
        // GroupFriendsOnly 会让客户端显示"只能邀请好友进群"—— 客户端严格按
        // 错误码出文案、丢弃服务端 message,用户看到的就是一句与事实相反、
        // 也无法照着做的提示。圈子群的同一场景用的就是这个码。
        errorCode: GroupErrorCode.InviteNotAllowed,
      });
    }
  }

  /** 座位落库后入房 + 个人事件(与圈子同步/单聊同一套广播语义;尽力而为)。 */
  private async seatMembersIntoRoom(
    conversationId: string,
    userIds: string[],
  ): Promise<void> {
    await Promise.all(
      userIds.map(async (memberId) => {
        try {
          await this.broadcast.joinUserToConversation(memberId, conversationId);
        } catch (error: unknown) {
          this.logger.warn(
            `join room failed user=${memberId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        this.broadcast.emitConversationChange(memberId, {
          kind: 'joined',
          conversationId,
          userId: memberId,
        });
      }),
    );
  }

  /** 进群系统提示(带昵称;查不到昵称就不发,不发空名单刷屏)。 */
  private async emitGroupJoinNotice(
    conversationId: string,
    joined: string[],
  ): Promise<void> {
    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: joined } },
        select: { nickname: true },
      });
      const names = users.map((u) => u.nickname).filter(Boolean);
      if (names.length > 0) {
        await this.systemMessage.emit(conversationId, {
          kind: 'member-joined',
          names,
        });
      }
    } catch (error) {
      this.logger.warn(
        `join notice failed conversation=${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    // 清空水位在这里同样要生效。只在 GET /chat/conversations 里过滤的话,
    // 客户端从「取或建会话」「改偏好」这两个响应回填缓存时,刚清掉的末条预览
    // (以及一条新签名的媒体 URL)就又回来了。
    const floor = member.clearedBeforeHeight ?? 0;
    const viewerCutoff = await this.selfDestructCutoff(userId);
    const seconds = member.conversation.burnDurationSec;
    const cutoff = this.strictestCutoff(
      viewerCutoff,
      seconds ? new Date(Date.now() - seconds * 1000) : null,
    );
    const [lastMessages, unread, peers, tempChats] = await Promise.all([
      this.loadLastMessages([conversationId], [cutoff]),
      this.loadUnreadCounts(
        userId,
        [
          {
            conversationID: conversationId,
            lastReadHeight: Math.max(member.lastReadHeight, floor),
          },
        ],
        [cutoff],
      ),
      member.conversation.type === 'DIRECT'
        ? this.loadDirectPeers(userId, [conversationId])
        : Promise.resolve(new Map<string, ChatSenderInfo>()),
      member.conversation.tempChatID
        ? this.loadTempChatInfos([member.conversation.tempChatID])
        : Promise.resolve(new Map<string, { id: string; title: string }>()),
    ]);
    const rawLast = lastMessages.get(conversationId) ?? null;
    const last = rawLast && rawLast.height <= floor ? null : rawLast;
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
      name: member.conversation.name ?? null,
      ownerId: member.conversation.ownerID ?? null,
      tempChat: member.conversation.tempChatID
        ? (tempChats.get(member.conversation.tempChatID) ?? null)
        : null,
      lastMessage,
      unreadCount: unread.get(conversationId) ?? 0,
      pinned: member.pinned,
      muted: member.muted,
      burnDurationSec: member.conversation.burnDurationSec ?? null,
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
    const { conversation, member } = await this.requireMembershipSeat(
      conversationId,
      userId,
    );
    const afterHeight = filters.afterHeight;
    // 两个游标语义相反(向旧翻页 vs 增量追平),同时给等于没说清要哪一页。
    if (beforeHeight !== undefined && afterHeight !== undefined) {
      throw new BadRequestException({
        message: 'beforeHeight and afterHeight are mutually exclusive',
      });
    }
    const ascendingPull = afterHeight !== undefined;
    const take = Math.min(Math.max(limit, 1), HISTORY_PAGE_MAX);
    // G-14 清空水位:本人只看得到水位之上的消息,与增量游标取更高者。
    const heightFloor = Math.max(
      afterHeight ?? 0,
      member.clearedBeforeHeight ?? 0,
    );
    // 自动销毁窗口:拆栈前由 chat-history.service 负责,自研栈落地时漏掉了 ——
    // 设置在库里、UI 上也能改,但读取路径根本不看它,用户以为过期的消息其实
    // 一直在。收在 where 里而不是取回来再 filter:后者会让分页数不准。
    // 访客(临时房)没有 User 行,查隐私设置只会拿到 2 天的默认值 —— 而临时房
    // 本身可以开 3 天甚至 7 天,于是活着的房间里超过 2 天的消息对访客凭空消失,
    // 他还没有任何地方能改这个设置。访客的保留边界是房间寿命,不是用户偏好。
    const viewerCutoff =
      options.applyViewerRetention === false
        ? null
        : await this.selfDestructCutoff(userId);
    // S-01 会话级焚毁:与查看者保留期取更严(更晚的截止时间)。sweeper 每分钟
    // 真删,这里的过滤盖住「已到期、尚未被扫掉」的窗口。
    const burnCutoff = conversation.burnDurationSec
      ? new Date(Date.now() - conversation.burnDurationSec * 1000)
      : null;
    const cutoff = this.strictestCutoff(viewerCutoff, burnCutoff);
    const heightCondition: Prisma.IntFilter = {
      ...(heightFloor > 0 ? { gt: heightFloor } : {}),
      ...(beforeHeight !== undefined ? { lt: beforeHeight } : {}),
    };
    const where: Prisma.ChatMessageWhereInput = {
      conversationID: conversationId,
      deleted: false,
      ...(Object.keys(heightCondition).length > 0
        ? { height: heightCondition }
        : {}),
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
      omit: MESSAGE_READ_OMIT,
      // 增量补拉从缺口低端往高处追;向旧翻页照旧取最近一段再反转。
      orderBy: { height: ascendingPull ? 'asc' : 'desc' },
      take,
    });
    const senderIds = rows
      .map((r) => r.senderID)
      .filter((id): id is string => id !== null);
    const senders = await this.resolveSenders(senderIds);
    const ascending = ascendingPull ? rows : [...rows].reverse();
    const messages = ascending.map((row) =>
      this.toMessageDto(row, this.senderFor(row, senders)),
    );
    // 引用快照必须和这一页用同一把尺子:清空水位之下、销毁窗口之外的原文
    // 不能借引用块绕回来。
    await this.attachReplyTo(messages, {
      heightFloors: new Map([
        [conversationId, member.clearedBeforeHeight ?? 0],
      ]),
      cutoff,
    });
    await this.attachReactions(messages);
    await this.media.attachMediaUrls(messages);
    if (ascendingPull) {
      return {
        messages,
        nextBeforeHeight: null,
        nextAfterHeight:
          rows.length === take ? rows[rows.length - 1].height : null,
      };
    }
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
      const tzEndOffset = filters.tzEndOffsetMinutes ?? tzOffset;
      const utcStart = Date.parse(`${filters.date}T00:00:00Z`);
      const start = utcStart + tzOffset * 60_000;
      const end = utcStart + 24 * 60 * 60 * 1000 + tzEndOffset * 60_000;
      if (Number.isFinite(start)) {
        where.createdAt = {
          gte: new Date(start),
          lt: new Date(end),
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
    timeZone?: string,
  ): Promise<string[]> {
    // 座位行也要带回来:下面按清空水位与销毁/焚毁窗口过滤(main 的 #143 改的是
    // 月份边界的时区算法,与这里的可见性过滤互不相干,两边都要)。
    const { conversation, member } = await this.requireMembershipSeat(
      conversationId,
      userId,
    );
    const formatter = timeZone
      ? new Intl.DateTimeFormat('en-US', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
      : undefined;
    const monthStart = formatter
      ? this.findUtcStartOfZonedDate(formatter, year, month, 1)
      : Date.UTC(year, month, 1) + tzOffsetMinutes * 60_000;
    const monthEnd = formatter
      ? this.findUtcStartOfZonedDate(formatter, year, month + 1, 1)
      : Date.UTC(year, month + 1, 1) + tzOffsetMinutes * 60_000;
    if (!Number.isFinite(monthStart) || !Number.isFinite(monthEnd)) return [];
    // 日历同样要按 getHistory 的尺子上色:清空/销毁/焚毁之后那些天点进去是空的,
    // 日历却还标着有记录。
    const floor = member.clearedBeforeHeight ?? 0;
    const cutoff = this.strictestCutoff(
      await this.selfDestructCutoff(userId),
      conversation.burnDurationSec
        ? new Date(Date.now() - conversation.burnDurationSec * 1000)
        : null,
    );
    const lowerBound = new Date(monthStart);
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        conversationID: conversationId,
        deleted: false,
        ...(floor > 0 ? { height: { gt: floor } } : {}),
        createdAt: {
          gte: cutoff && cutoff > lowerBound ? cutoff : lowerBound,
          lt: new Date(monthEnd),
        },
      },
      select: { createdAt: true },
      take: 5000,
    });
    const days = new Set<string>();
    for (const row of rows) {
      if (formatter) {
        days.add(this.formatZonedDate(formatter, row.createdAt));
      } else {
        const local = new Date(
          row.createdAt.getTime() - tzOffsetMinutes * 60_000,
        );
        days.add(local.toISOString().slice(0, 10));
      }
    }
    return [...days].sort((a, b) => (a < b ? -1 : 1));
  }

  private findUtcStartOfZonedDate(
    formatter: Intl.DateTimeFormat,
    year: number,
    month: number,
    day: number,
  ): number {
    const normalized = new Date(Date.UTC(year, month, day));
    const target = normalized.toISOString().slice(0, 10);
    let low = normalized.getTime() - 36 * 60 * 60 * 1000;
    let high = normalized.getTime() + 36 * 60 * 60 * 1000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.formatZonedDate(formatter, new Date(middle)) < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private formatZonedDate(formatter: Intl.DateTimeFormat, date: Date): string {
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    return `${year}-${month}-${day}`;
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
      select: { conversationID: true, clearedBeforeHeight: true },
    });
    if (memberships.length === 0) return [];
    // 搜索必须和 getHistory 用同一把尺子:否则自动销毁窗口之外的消息
    // 在历史里看不到、一搜就出来了,等于开了后门。清空水位与会话焚毁同理 ——
    // 「清空聊天记录」之后原文一搜即出,这个功能就等于没做。
    const cutoff = await this.selfDestructCutoff(userId);
    const burning = await this.prisma.chatConversation.findMany({
      where: {
        id: { in: memberships.map((m) => m.conversationID) },
        burnDurationSec: { not: null },
      },
      select: { id: true, burnDurationSec: true },
    });
    const burnById = new Map(burning.map((c) => [c.id, c.burnDurationSec]));
    // 大多数会话既没清空过也没开焚毁 —— 那些合成一个 IN,只有带水位/焚毁的
    // 才各自展开一支,OR 的分支数因此正比于「特殊会话数」而不是会话总数。
    const plain: string[] = [];
    const scoped: Prisma.ChatMessageWhereInput[] = [];
    const heightFloors = new Map<string, number>();
    const cutoffs = new Map<string, Date | null>();
    for (const m of memberships) {
      const floor = m.clearedBeforeHeight ?? 0;
      const seconds = burnById.get(m.conversationID) ?? null;
      const burnCutoff = seconds ? new Date(Date.now() - seconds * 1000) : null;
      const viewerCutoff = this.strictestCutoff(cutoff, burnCutoff);
      heightFloors.set(m.conversationID, floor);
      cutoffs.set(m.conversationID, viewerCutoff);
      if (floor <= 0 && !burnCutoff) {
        plain.push(m.conversationID);
        continue;
      }
      scoped.push({
        conversationID: m.conversationID,
        ...(floor > 0 ? { height: { gt: floor } } : {}),
        ...(burnCutoff ? { createdAt: { gte: burnCutoff } } : {}),
      });
    }
    const scope: Prisma.ChatMessageWhereInput[] = [];
    if (plain.length > 0) scope.push({ conversationID: { in: plain } });
    scope.push(...scoped);
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        OR: scope,
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
    const messages = rows.map((row) =>
      this.toMessageDto(row, this.senderFor(row, senders)),
    );
    // quote 行的 content.quotedText 是客户端塞的原文快照:搜索之前从不过
    // attachReplyTo,于是被撤回的原文在搜索结果里原样返回。
    await this.attachReplyTo(messages, { heightFloors, cutoffs });
    return messages;
  }

  /**
   * 离线期间发生过的撤回/编辑增量(重连后一次追平)。
   *
   * 重连补拉走的是 `height > afterHeight` —— 撤回**不改 height**,所以那条路径
   * 结构上永远看不到它:设备离线时被撤回的那条消息,本地缓存里一直是原文,
   * 只有等它恰好落进某次历史分页才会被覆盖。会话热闹一点就永远等不到。
   * 于是这里按 revokedAt/editedAt 时间轴单独给一条增量通道。
   *
   * 只回本人在座会话;仍旧套清空水位与销毁/焚毁窗口(不可见的行连撤回状态
   * 都不必回,客户端本来就该看不到)。
   */
  async listMutationsSince(
    userId: string,
    since: Date,
    limit = MUTATION_PAGE_MAX,
    sinceId = '',
  ): Promise<ChatMutationsPageDto> {
    const serverTime = new Date().toISOString();
    const lookbackFloor = new Date(Date.now() - MUTATION_LOOKBACK_MS);
    // 空响应的游标同样不能推到 serverTime —— 「一次什么都没查到的同步」正是
    // 未提交写最容易被跨过去的时刻:那条撤回的时间戳已经生成、行还没可见,
    // 游标一旦越过它,它提交之后就永远追不到了。同样卡在安全水位上,
    // 且绝不倒退到 since 之前。
    const safeCursor = new Date(
      Math.max(since.getTime(), Date.now() - MUTATION_SAFETY_LAG_MS),
    ).toISOString();
    const empty: ChatMutationsPageDto = {
      messages: [],
      serverTime,
      nextSince: safeCursor,
      nextSinceId: '',
      hasMore: false,
      resetRequired: false,
    };
    // 游标比保留窗口还老:这段时间里的撤回/编辑已经查不到了。
    // 原来是默默把游标抬到窗口下沿 —— 客户端于是以为自己追平了,而那段区间里
    // 被撤回的消息在它的缓存里永远是原文(撤回不改 height,历史补拉够不着)。
    // 如实告诉它「缓存作废,重新拉」。
    if (since < lookbackFloor) {
      return {
        ...empty,
        // 全量重建之后的第一段增量同样从安全水位起算。
        nextSince: new Date(Date.now() - MUTATION_SAFETY_LAG_MS).toISOString(),
        resetRequired: true,
      };
    }
    const memberships = await this.prisma.chatMember.findMany({
      where: { userID: userId, leftAt: null },
      select: { conversationID: true, clearedBeforeHeight: true },
    });
    if (memberships.length === 0) return empty;

    // 每会话的可见边界:清空水位 + 焚毁/自动销毁截止。必须进 SQL 的 WHERE ——
    // 取回来再 filter 的话,被过滤掉的行照样占着 LIMIT 的名额,一页里真正
    // 该返回的变更就少了,而客户端游标照常前进,那些变更从此再也追不到。
    const burning = await this.prisma.chatConversation.findMany({
      where: {
        id: { in: memberships.map((m) => m.conversationID) },
        burnDurationSec: { not: null },
      },
      select: { id: true, burnDurationSec: true },
    });
    const burnById = new Map(burning.map((c) => [c.id, c.burnDurationSec]));
    const viewerCutoff = await this.selfDestructCutoff(userId);
    const ids: string[] = [];
    const floors: number[] = [];
    const cutoffs: (Date | null)[] = [];
    const heightFloors = new Map<string, number>();
    for (const m of memberships) {
      const seconds = burnById.get(m.conversationID) ?? null;
      const burnCutoff = seconds ? new Date(Date.now() - seconds * 1000) : null;
      ids.push(m.conversationID);
      floors.push(m.clearedBeforeHeight ?? 0);
      cutoffs.push(this.strictestCutoff(viewerCutoff, burnCutoff));
      heightFloors.set(m.conversationID, m.clearedBeforeHeight ?? 0);
    }

    // 多取一条用来判断「还有没有」。
    //
    // 游标是 (mutatedAt, id) 复合键,不是单一时间戳:DateTime 只有毫秒精度,
    // 一批同毫秒的变更跨在页边界上时,单时间戳游标配 `> from` 会把剩下那些
    // 同刻的行永久跳过。撤回与编辑各有各的时间戳,统一成 GREATEST 才排得出
    // 单调序 —— Prisma 的多字段 orderBy 做不到这件事,所以走原始 SQL。
    //
    // WHERE 里那条 `revokedAt >= ... OR editedAt >= ...` 是给索引用的粗筛
    // (GREATEST 表达式本身走不了索引);精确的 keyset 判定叠在它上面。
    const take = Math.min(Math.max(limit, 1), MUTATION_PAGE_MAX);
    const rows = await this.prisma.$queryRaw<
      Array<MessageRow & { mutatedAt: Date }>
    >`
      SELECT m."id", m."conversationID", m."height", m."senderID", m."type",
             m."content", m."clientMessageId", m."replyToID", m."deleted",
             m."revokedAt", m."revokedBy", m."editedAt", m."createdAt",
             GREATEST(
               COALESCE(m."revokedAt", to_timestamp(0)),
               COALESCE(m."editedAt", to_timestamp(0))
             ) AS "mutatedAt"
      FROM "ChatMessage" AS m
      JOIN unnest(${ids}::text[], ${floors}::int[], ${cutoffs}::timestamptz[])
        AS w("conversationID", floor, cutoff)
        ON w."conversationID" = m."conversationID"
      WHERE m."height" > w.floor
        AND (w.cutoff IS NULL OR m."createdAt" >= w.cutoff)
        AND (m."revokedAt" >= ${since} OR m."editedAt" >= ${since})
        AND (
          GREATEST(
            COALESCE(m."revokedAt", to_timestamp(0)),
            COALESCE(m."editedAt", to_timestamp(0))
          ) > ${since}
          OR (
            GREATEST(
              COALESCE(m."revokedAt", to_timestamp(0)),
              COALESCE(m."editedAt", to_timestamp(0))
            ) = ${since}
            AND m."id" > ${sinceId}
          )
        )
      ORDER BY "mutatedAt" ASC, m."id" ASC
      LIMIT ${take + 1}
    `;

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    if (page.length === 0) return empty;
    const cursor = this.nextMutationCursor(since, sinceId, page, hasMore);
    const senders = await this.resolveSenders(
      page.map((r) => r.senderID).filter((id): id is string => id !== null),
    );
    const messages = page.map((row) =>
      this.toMessageDto(row, this.senderFor(row, senders)),
    );
    await this.attachReplyTo(messages, { heightFloors });
    return { messages, serverTime, ...cursor, resetRequired: false };
  }

  /**
   * 下一次请求该用的游标。
   *
   * 两条约束叠在一起:
   * ① 截断了就停在本页最后一条上(回 serverTime 会把没返回的那些永久跳过);
   * ② 无论如何不越过安全水位 `now - MUTATION_SAFETY_LAG_MS` —— 时间戳在写语句
   *    构造时生成、行到 COMMIT 才可见,一次被锁住的撤回完全可能「时间戳很早、
   *    提交很晚」,游标越过它的时间戳它就永远追不到了(见常量处的说明)。
   *
   * ② 会让游标推不动(整页都落在不安全窗口里、且水位不比 since 新):那就报
   * 「已追平」让客户端停手 —— 本页已经投递过了,剩下的下次同步再来。谎报
   * hasMore 而游标原地不动会让客户端空转。
   */
  private nextMutationCursor(
    since: Date,
    sinceId: string,
    page: Array<MessageRow & { mutatedAt: Date }>,
    truncated: boolean,
  ): { nextSince: string; nextSinceId: string; hasMore: boolean } {
    const last = page[page.length - 1];
    const safeCeiling = Date.now() - MUTATION_SAFETY_LAG_MS;
    const desired = truncated ? last.mutatedAt.getTime() : Date.now();
    const capped = Math.min(desired, safeCeiling);
    if (capped <= since.getTime()) {
      return {
        nextSince: since.toISOString(),
        nextSinceId: sinceId,
        hasMore: false,
      };
    }
    // 游标正好落在某一行上时才带 id(复合 keyset);落在水位上则没有对应行。
    const landedOnRow = truncated && capped === last.mutatedAt.getTime();
    return {
      nextSince: new Date(capped).toISOString(),
      nextSinceId: landedOnRow ? last.id : '',
      hasMore: truncated,
    };
  }

  /** 两个「不早于」截止时间取更严的一个(更晚者);都为空则不过滤。 */
  private strictestCutoff(a: Date | null, b: Date | null): Date | null {
    if (a && b) return a > b ? a : b;
    return a ?? b;
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
    // 会话在本次调用之前就存在 → 双方连接时 handleConnection 已经把它们加进房了
    // (它按 leftAt: null 取,而 DIRECT 座位的 leftAt 恒为空 —— 置空只发生在
    //  圈子同步与临时房访客收座上)。这里再 join 一次只是白花一次跨节点
    // fetchSockets。
    if (existing) return existing.id;
    let conversationId: string;
    try {
      const created = await this.prisma.chatConversation.create({
        data: {
          type: 'DIRECT',
          directKey,
          members: { create: [{ userID: userId }, { userID: peerUserId }] },
        },
        select: { id: true },
      });
      conversationId = created.id;
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.chatConversation.findUnique({
        where: { directKey },
        select: { id: true },
      });
      if (!raced) throw error;
      // 竞态里对手赢了插入,但它的 join 未必已经跑完 —— 而调用方紧接着就要往
      // 这个房间里播回执。补一次(join 幂等)比赌时序便宜。
      conversationId = raced.id;
    }
    // 刚建出来的会话:座位落库不会自动 join,而 handleConnection 只把**连接那一刻**
    // 已存在的会话加进房。不补这一步,调用方紧接着 insertServerMessage 的广播就播
    // 进一个空房间 —— 转账卡/通话留痕/好友申请回放对双方都静默消失,要等下次重连
    // 或拉历史才看得见;推送分流还会把在线的对端当成离线用户。补偿 cron 那条路更糟:
    // 它在广播之后就置位 cardDeliveredAt,于是永远不会再重试。
    // 尽力而为,失败不阻断结算链路(客户端重连时 handleConnection 会补上)。
    await Promise.all(
      [userId, peerUserId].map((memberId) =>
        this.broadcast
          .joinUserToConversation(memberId, conversationId)
          .catch((error: unknown) => {
            this.logger.warn(
              `join settlement conversation room failed user=${memberId} conv=${conversationId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }),
      ),
    );
    return conversationId;
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
      // 客服豁免:客服本人在 App 里关掉「接收陌生人消息」会静默切断整条客服通道,
      // 而且失效时没有任何信号 —— 用户只会看到「对方不接收陌生人消息」。做成服务端
      // 规则而不是靠约束客服的个人设置,后者防不住误操作。
      // 拉黑判定(上面的 assertNotBlockedBetween)与账号 status 检查不在豁免范围内。
      const isSupport = await this.support.isSupportAgent(peerUserId);
      const allowed =
        isSupport ||
        (await this.privacySettings.canReceiveStrangerMessage(
          peerUserId,
          friends,
        ));
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

    const clearedFloor = mine?.clearedBeforeHeight ?? 0;
    const viewerCutoff = await this.selfDestructCutoff(userId);
    const burnSeconds = conv.burnDurationSec;
    const cutoff = this.strictestCutoff(
      viewerCutoff,
      burnSeconds ? new Date(Date.now() - burnSeconds * 1000) : null,
    );
    const [unread, lastMessage] = await Promise.all([
      mine
        ? this.loadUnreadCounts(
            userId,
            [
              {
                conversationID: conv.id,
                lastReadHeight: Math.max(mine.lastReadHeight, clearedFloor),
              },
            ],
            [cutoff],
          )
        : Promise.resolve(new Map<string, number>()),
      // 命中已有会话时必须回真实末条:客户端拿这个响应回填会话缓存,
      // 恒 null 会把已有会话的预览抹成空白,与 GET /chat/conversations 打架。
      // 但清空水位之下的末条不算「真实末条」——(见 buildConversationDto)。
      this.loadLastMessageFor(conv.id, clearedFloor, cutoff),
    ]);
    return {
      id: conv.id,
      type: conv.type,
      peer: { id: peer.id, nickname: peer.nickname, avatarUrl: peer.avatarUrl },
      circleId: null,
      circle: null,
      name: null,
      ownerId: null,
      tempChat: null,
      lastMessage,
      unreadCount: unread.get(conv.id) ?? 0,
      pinned: mine?.pinned ?? false,
      muted: mine?.muted ?? false,
      burnDurationSec: conv.burnDurationSec ?? null,
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
    heightFloor = 0,
    cutoff: Date | null = null,
  ): Promise<ChatMessageDto | null> {
    const row = await this.prisma.chatMessage.findFirst({
      where: {
        conversationID: conversationId,
        deleted: false,
        ...(heightFloor > 0 ? { height: { gt: heightFloor } } : {}),
        ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
      },
      omit: MESSAGE_READ_OMIT,
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
    // 圈子群的目录只开放给圈主/管理员;独立群聊(无 circleID)是微信群语义,
    // 成员就是彼此拉进来的好友网络,全员可见目录(邀请选人也依赖它)。
    if (conversation.type === 'GROUP' && conversation.circleID) {
      const membership = await this.prisma.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: userId,
            circleID: conversation.circleID,
          },
        },
        select: { role: true, status: true },
      });
      const canViewDirectory =
        membership?.status === 'ACTIVE' &&
        (membership.role === 'OWNER' || membership.role === 'ADMIN');
      if (!canViewDirectory) {
        throw new ForbiddenException({
          message: '仅圈主和管理员可查看群成员目录',
          errorCode: ChatErrorCode.MemberDirectoryForbidden,
        });
      }
    }
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

  /**
   * 访客打开笔记卡片前的授权解析：必须仍在本会话座位上，消息必须属于本会话、
   * 未删除/未撤回且确实是 note-card。只返回指针，不在聊天层读取笔记正文。
   */
  async getNoteCardNoteId(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<string> {
    await this.requireMembership(conversationId, userId);
    const row = await this.prisma.chatMessage.findFirst({
      where: {
        id: messageId,
        conversationID: conversationId,
        type: 'note-card',
        deleted: false,
        revokedAt: null,
      },
      select: { content: true },
    });
    const content = row?.content;
    const noteId =
      content && typeof content === 'object' && !Array.isArray(content)
        ? (content as Record<string, unknown>)['noteId']
        : undefined;
    if (typeof noteId !== 'string' || noteId.length === 0) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    return noteId;
  }

  /** 成员校验:会话存在且本人在座(未退出),返回会话行供类型分支使用。 */
  private async requireMembership(
    conversationId: string,
    userId: string,
  ): Promise<ChatConversation> {
    const { conversation } = await this.requireMembershipSeat(
      conversationId,
      userId,
    );
    return conversation;
  }

  /** 同 requireMembership,但把成员行也带回来(清空水位等 per-viewer 状态在行上)。 */
  private async requireMembershipSeat(
    conversationId: string,
    userId: string,
  ): Promise<{ conversation: ChatConversation; member: ChatMember }> {
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
    return { conversation: member.conversation, member };
  }

  /**
   * 单聊里「改动已有消息 / 改动会话共享设置」前的拉黑复查。
   *
   * sendMessage 早就拦了拉黑,但回应、编辑、阅后即焚这些后加的写路径只查了在座 ——
   * 而拉黑**故意**不摘座位,于是被拉黑的一方照样能改消息、往对方房间推事件,
   * 甚至把整个会话设成 30 秒焚毁,替对方销毁历史。非单聊会话直接放行。
   */
  private async assertDirectMutationAllowed(
    conversation: ChatConversation,
    userId: string,
  ): Promise<void> {
    if (conversation.type !== 'DIRECT') return;
    await this.assertDirectNotBlocked(conversation, userId);
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
    cutoffs: (Date | null)[],
  ): Promise<Map<string, MessageRow>> {
    if (conversationIds.length === 0) return new Map();
    // 列名逐个写出而不是 SELECT *:唯一的目的是别把 contentHistory 拖进来
    // (见 MessageRow 上的注释)。原始 SQL 绕过 Prisma 的 omit,只能手写。
    const rows = await this.prisma.$queryRaw<MessageRow[]>`
      SELECT DISTINCT ON (m."conversationID")
        m."id", m."conversationID", m."height", m."senderID", m."type", m."content",
        m."clientMessageId", m."replyToID", m."deleted", m."revokedAt", m."revokedBy",
        m."editedAt", m."createdAt"
      FROM "ChatMessage" AS m
      JOIN unnest(${conversationIds}::text[], ${cutoffs}::timestamptz[])
        AS w("conversationID", cutoff)
        ON w."conversationID" = m."conversationID"
      WHERE m."deleted" = false
        AND (w.cutoff IS NULL OR m."createdAt" >= w.cutoff)
      ORDER BY m."conversationID", m."height" DESC
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
    cutoffs: (Date | null)[],
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
      JOIN unnest(${ids}::text[], ${floors}::int[], ${cutoffs}::timestamptz[])
        AS w("conversationID", floor, cutoff)
        ON w."conversationID" = m."conversationID"
      WHERE m."deleted" = false
        AND m."height" > w.floor
        AND (w.cutoff IS NULL OR m."createdAt" >= w.cutoff)
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

  /** TEMP 会话的稳定展示信息(房间名来源)。 */
  private async loadTempChatInfos(
    tempChatIds: string[],
  ): Promise<Map<string, { id: string; title: string }>> {
    const unique = [...new Set(tempChatIds)];
    if (unique.length === 0) return new Map();
    const rooms = await this.prisma.tempChat.findMany({
      where: { id: { in: unique } },
      select: { id: true, title: true },
    });
    return new Map(rooms.map((room) => [room.id, room]));
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
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedBy: row.revokedBy ?? null,
      ...(row.editedAt ? { editedAt: row.editedAt.toISOString() } : {}),
      d: row.clientMessageId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * G-09 真引用:一次 IN 批量取被引用消息,挂 replyTo 快照(禁 N+1)。
   * 原消息被物理删除时缺省(前端回落 quotedText 文本快照);已撤回则
   * revoked=true 且 preview 为空,前端渲染「消息已撤回」。
   *
   * 快照必须按**查看者**能看到什么来生成,不是按库里有什么:
   * - 跨会话的引用一律不挂(发送侧已拦,历史里的存量数据同样不能漏);
   * - 被引用消息在查看者的清空水位之下、或超出他的自动销毁/会话焚毁窗口时,
   *   引用块等于把已经藏起来的内容原样端回来,所以按「不可见」处理;
   * - 上述任一情况下,连客户端塞的 `content.quotedText` 文本快照也要一起抹掉 ——
   *   否则撤回/清空之后,那段原文仍然躺在引用消息自己的 content 里照常返回。
   */
  private async attachReplyTo(
    messages: ChatMessageDto[],
    visibility: {
      heightFloors?: Map<string, number>;
      cutoffs?: Map<string, Date | null>;
      cutoff?: Date | null;
    } = {},
  ): Promise<void> {
    const ids = [
      ...new Set(
        messages
          .map((m) => m.replyToId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    ];
    if (ids.length === 0) return;
    const rows = await this.prisma.chatMessage.findMany({
      where: { id: { in: ids } },
      omit: MESSAGE_READ_OMIT,
    });
    const senderIds = rows
      .map((r) => r.senderID)
      .filter((id): id is string => id !== null);
    const senders = await this.resolveSenders(senderIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const message of messages) {
      if (!message.replyToId) continue;
      const row = byId.get(message.replyToId);
      const cutoff =
        visibility.cutoffs?.get(message.conversationId) ?? visibility.cutoff;
      const visible =
        !!row &&
        !row.deleted &&
        row.conversationID === message.conversationId &&
        row.height >
          (visibility.heightFloors?.get(message.conversationId) ?? 0) &&
        (!cutoff || row.createdAt >= cutoff);
      if (!visible || row.revokedAt !== null) {
        this.stripQuotedText(message);
      }
      if (!visible || !row) continue;
      const revoked = row.revokedAt !== null;
      message.replyTo = {
        id: row.id,
        height: row.height,
        senderNickname: this.senderFor(row, senders)?.nickname ?? '',
        type: row.type,
        preview: revoked ? '' : previewOfContent(row.type, row.content),
        revoked,
      };
    }
  }

  /** 引用源不可见/已撤回时,连客户端的文本快照一并抹掉(不改库,只改出参)。 */
  private stripQuotedText(message: ChatMessageDto): void {
    const content = message.content;
    if (!content || typeof content['quotedText'] !== 'string') return;
    message.content = { ...content, quotedText: '' };
  }

  /**
   * G-02 消息撤回:发送者本人限 CHAT_REVOKE_WINDOW_MS 时间窗;
   * GROUP 会话的圈主/管理员不受窗口限制、可撤他人消息。
   * 撤回的消息仍占 height(坐标系不塌陷),content 清空,媒体对象一并删。
   */
  async revokeMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<ChatMessageDto> {
    const conversation = await this.requireMembership(conversationId, userId);
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      omit: MESSAGE_READ_OMIT,
    });
    if (!row || row.conversationID !== conversationId || row.deleted) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    if (row.revokedAt) {
      // 幂等:双端并发撤回/重试不再广播第二次。
      const senders = await this.resolveSenders(
        row.senderID ? [row.senderID] : [],
      );
      return this.toMessageDto(row, this.senderFor(row, senders));
    }
    if (row.senderID === null) {
      // 系统消息(进退群提示、burn-changed 留痕)没有作者,下面那条
      // 「不是我发的 → 看管理员身份」的分支会把它算成管理员可撤 ——
      // 于是圈主可以开了阅后即焚,再顺手把「对方开启了阅后即焚」这条
      // 唯一的痕迹撤掉。留痕的意义正在于撤不掉。
      throw new ForbiddenException({
        message: '系统消息不可撤回',
        errorCode: ChatErrorCode.RevokeForbidden,
      });
    }
    if (row.senderID === userId) {
      const expired =
        Date.now() - row.createdAt.getTime() > CHAT_REVOKE_WINDOW_MS;
      // 窗口过期的自己消息:圈主/管理员身份可豁免(管理动作),普通成员拒。
      if (expired && !(await this.isCircleModerator(conversation, userId))) {
        throw new ForbiddenException({
          message: '超出可撤回时间',
          errorCode: ChatErrorCode.RevokeWindowExpired,
        });
      }
    } else if (!(await this.isCircleModerator(conversation, userId))) {
      throw new ForbiddenException({
        message: '无权撤回该消息',
        errorCode: ChatErrorCode.RevokeForbidden,
      });
    }

    const mediaKeys = this.collectMediaKeys(row);
    // 条件更新替无条件 update:上面那次 revokedAt 读取和这次写入之间有窗口,
    // 双端并发撤回(或发送者与管理员同时动手)会两个都读到 null、两个都写、
    // 两个都广播,revokedBy 归后写者 —— 幂等承诺和审计归属一起破。
    // 谓词带上 revokedAt: null,只有赢家 count>0,输家走幂等分支重读。
    const claimed = await this.prisma.chatMessage.updateMany({
      where: { id: messageId, revokedAt: null },
      data: { content: {}, revokedAt: new Date(), revokedBy: userId },
    });
    const updated = await this.prisma.chatMessage.findUniqueOrThrow({
      where: { id: messageId },
      omit: MESSAGE_READ_OMIT,
    });
    if (claimed.count === 0) {
      const senders = await this.resolveSenders(
        updated.senderID ? [updated.senderID] : [],
      );
      return this.toMessageDto(updated, this.senderFor(updated, senders));
    }
    if (mediaKeys.length > 0) {
      // 尽力而为:删失败只留孤儿对象,不让撤回失败(deleteObjects 内部逐个 catch)。
      void this.media.deleteObjects(mediaKeys);
    }
    this.broadcast.emitRevoke({
      conversationId,
      messageId,
      revokedBy: userId,
    });
    const senders = await this.resolveSenders(
      updated.senderID ? [updated.senderID] : [],
    );
    return this.toMessageDto(updated, this.senderFor(updated, senders));
  }

  /** G-07 送达水位:与 markRead 同款钳制与只前进语义。 */
  async markDelivered(
    userId: string,
    conversationId: string,
    height: number,
  ): Promise<{ advanced: boolean; height: number }> {
    if (!Number.isInteger(height) || height < 0) {
      throw new BadRequestException({
        message: '送达水位非法',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    await this.requireMembership(conversationId, userId);
    const top = await this.prisma.chatMessage.aggregate({
      where: { conversationID: conversationId, deleted: false },
      _max: { height: true },
    });
    const clamped = Math.min(height, top._max.height ?? 0);
    if (clamped <= 0) return { advanced: false, height: 0 };
    const updated = await this.prisma.chatMember.updateMany({
      where: {
        conversationID: conversationId,
        userID: userId,
        lastDeliveredHeight: { lt: clamped },
      },
      data: { lastDeliveredHeight: clamped },
    });
    return { advanced: updated.count > 0, height: clamped };
  }

  /**
   * G-07 表情回应:不进 height 坐标系(不是消息、不推进未读、不改
   * lastMessageAt)。emoji 收白名单;add 幂等(撞唯一约束视为已存在)。
   * 返回 changed=false 表示无变化(重复 add / remove 不存在的行),
   * 调用方据此决定是否广播。
   */
  async toggleReaction(
    userId: string,
    conversationId: string,
    messageId: string,
    emoji: string,
    op: 'add' | 'remove',
  ): Promise<{ changed: boolean }> {
    if (!CHAT_REACTION_EMOJIS.includes(emoji)) {
      throw new BadRequestException({
        message: '不支持的表情',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    const conversation = await this.requireMembership(conversationId, userId);
    // 单聊拉黑不摘座位(两边的 ChatMember 都留着),所以只查在座是不够的:
    // 被拉黑的一方发不了消息,却能靠回应和编辑继续往对方房间里推事件。
    await this.assertDirectMutationAllowed(conversation, userId);
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { conversationID: true, deleted: true, revokedAt: true },
    });
    if (!row || row.conversationID !== conversationId || row.deleted) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    if (row.revokedAt) {
      // 已撤回的消息不接受新回应;静默无变化,不给撤回消息续热度。
      return { changed: false };
    }
    if (op === 'add') {
      try {
        await this.prisma.chatMessageReaction.create({
          data: { messageID: messageId, userID: userId, emoji },
        });
        return { changed: true };
      } catch (error) {
        if (this.isUniqueViolation(error)) return { changed: false };
        throw error;
      }
    }
    const removed = await this.prisma.chatMessageReaction.deleteMany({
      where: { messageID: messageId, userID: userId, emoji },
    });
    return { changed: removed.count > 0 };
  }

  /**
   * G-07 消息编辑:仅发送者本人、仅 text/quote、CHAT_EDIT_WINDOW_MS 窗口内。
   * height 不变(排序坐标系不动);旧 content 进 contentHistory 留痕;
   * 新文本照常过敏感词。
   */
  async editMessage(
    userId: string,
    conversationId: string,
    messageId: string,
    content: { text: string },
  ): Promise<ChatMessageDto> {
    const text = typeof content?.text === 'string' ? content.text.trim() : '';
    if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException({
        message: '编辑内容非法',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    const hit = this.sensitiveWords.check(text);
    if (hit.blocked) {
      throw new BadRequestException({
        message: '内容包含敏感词',
        errorCode: ChatErrorCode.SensitiveWord,
      });
    }
    const conversation = await this.requireMembership(conversationId, userId);
    await this.assertDirectMutationAllowed(conversation, userId);
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });
    if (
      !row ||
      row.conversationID !== conversationId ||
      row.deleted ||
      row.revokedAt
    ) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    if (row.senderID !== userId) {
      throw new ForbiddenException({
        message: '只能编辑自己的消息',
        errorCode: ChatErrorCode.EditForbidden,
      });
    }
    if (row.type !== 'text' && row.type !== 'quote') {
      throw new BadRequestException({
        message: '该类型消息不支持编辑',
        errorCode: ChatErrorCode.EditForbidden,
      });
    }
    if (Date.now() - row.createdAt.getTime() > CHAT_EDIT_WINDOW_MS) {
      throw new ForbiddenException({
        message: '超出可编辑时间',
        errorCode: ChatErrorCode.EditWindowExpired,
      });
    }
    const previous = (row.content ?? {}) as Record<string, unknown>;
    const history = Array.isArray(row.contentHistory)
      ? [...(row.contentHistory as unknown[])]
      : [];
    history.push(previous);
    // quote 只改 text,引用快照字段原样保留。
    const nextContent = { ...previous, text } as Prisma.InputJsonObject;
    // 谓词带上 revokedAt/deleted:上面那次读到写入之间,这条消息可能刚被撤回
    // 或被焚毁扫走。按 id 无条件写会把正文塞回一条 revokedAt 非空的行 ——
    // 库里成了「已撤回但有内容」,随后的 chat:edit 广播还会在客户端盖掉
    // 撤回事件,搜索也能搜出那段本该消失的文本。输了就当消息不存在。
    const applied = await this.prisma.chatMessage.updateMany({
      where: { id: messageId, revokedAt: null, deleted: false },
      data: {
        content: nextContent,
        editedAt: new Date(),
        contentHistory: history as Prisma.InputJsonValue,
      },
    });
    if (applied.count === 0) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    const updated = await this.prisma.chatMessage.findUniqueOrThrow({
      where: { id: messageId },
      omit: MESSAGE_READ_OMIT,
    });
    // 与 sendMessage 同样的理由:写已经提交了,装饰失败不能让这次编辑
    // 「对外没发生过」—— 网关不广播,客户端还看着旧文本,而且编辑没有幂等键,
    // 重试只会再往 contentHistory 里压一层。
    const dto = await this.decorateCommittedMessage(updated);
    return dto;
  }

  /** 写已提交之后的装饰(昵称/引用快照):任何失败都降级,绝不抛。 */
  private async decorateCommittedMessage(
    row: MessageRow,
  ): Promise<ChatMessageDto> {
    let sender: ChatSenderInfo | null = null;
    try {
      sender = row.senderID
        ? ((await this.resolveSenders([row.senderID])).get(row.senderID) ??
          null)
        : null;
    } catch (error) {
      this.logger.warn(
        `sender enrichment failed after commit message=${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const dto = this.toMessageDto(row, sender);
    try {
      await this.attachReplyTo([dto]);
    } catch (error) {
      this.logger.warn(
        `reply enrichment failed after commit message=${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return dto;
  }

  /**
   * G-07 逐条已读回执:读者 = lastReadHeight ≥ 该消息 height 的在座成员。
   * 自研栈红利 —— 不需要回执表,水位即事实。发送者本人不计入。
   */
  async listMessageReaders(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ readers: ChatSenderInfo[]; total: number }> {
    await this.requireMembership(conversationId, userId);
    const row = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: {
        conversationID: true,
        height: true,
        senderID: true,
        createdAt: true,
      },
    });
    if (!row || row.conversationID !== conversationId) {
      throw new NotFoundException({
        message: '消息不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    // 新入群/重新入群的座位,lastReadHeight 是按「当前最高」初始化的(否则新人
    // 一进来就背着全群历史未读)。那个初始水位不是回执:不排掉的话,一个刚进群
    // 的人会显示成群里每一条老消息的已读者。座位的 joinedAt 之后才算数。
    const where: Prisma.ChatMemberWhereInput = {
      conversationID: conversationId,
      leftAt: null,
      lastReadHeight: { gte: row.height },
      joinedAt: { lte: row.createdAt },
      ...(row.senderID ? { userID: { not: row.senderID } } : {}),
    };
    const [seats, total] = await Promise.all([
      this.prisma.chatMember.findMany({
        where,
        select: { userID: true },
        orderBy: { joinedAt: 'asc' },
        take: READERS_PAGE_MAX,
      }),
      // total 必须单独 count:拿这一页的长度当总数,3000 人的群会稳定显示
      // 「200 人已读」,前端也没法判断该不该提示还有更多。
      this.prisma.chatMember.count({ where }),
    ]);
    const senders = await this.resolveSenders(seats.map((s) => s.userID));
    const readers = seats
      .map((s) => senders.get(s.userID))
      .filter((s): s is ChatSenderInfo => Boolean(s));
    return { readers, total };
  }

  /** G-07:一次 IN 批量把表情回应聚合挂到消息上(禁 N+1)。 */
  private async attachReactions(messages: ChatMessageDto[]): Promise<void> {
    const ids = messages
      .filter((m) => m.height > 0 && !m.revokedAt)
      .map((m) => m.id);
    if (ids.length === 0) return;
    const rows = await this.prisma.chatMessageReaction.findMany({
      where: { messageID: { in: ids } },
      orderBy: { createdAt: 'asc' },
      select: { messageID: true, userID: true, emoji: true },
    });
    if (rows.length === 0) return;
    const byMessage = new Map<string, Map<string, string[]>>();
    for (const row of rows) {
      const perEmoji =
        byMessage.get(row.messageID) ?? new Map<string, string[]>();
      const users = perEmoji.get(row.emoji) ?? [];
      users.push(row.userID);
      perEmoji.set(row.emoji, users);
      byMessage.set(row.messageID, perEmoji);
    }
    for (const message of messages) {
      const perEmoji = byMessage.get(message.id);
      if (!perEmoji) continue;
      message.reactions = [...perEmoji.entries()].map(([emoji, userIds]) => ({
        emoji,
        userIds,
      }));
    }
  }

  /**
   * S-01 会话级阅后即焚:任一方(DIRECT)或圈主/管理员(GROUP)设置,双方生效。
   * 变更留系统消息痕迹;真删由每分钟 sweeper 执行,读路径过滤盖住间隙。
   */
  async setBurnDuration(
    userId: string,
    conversationId: string,
    seconds: number | null,
  ): Promise<{ burnDurationSec: number | null }> {
    const { conversation } = await this.requireMembershipSeat(
      conversationId,
      userId,
    );
    if (conversation.type === 'TEMP') {
      // 访客的保留边界是房间寿命,不是会话设置。
      throw new BadRequestException({
        message: '临时聊天不支持阅后即焚',
        errorCode: ChatErrorCode.InvalidPayload,
      });
    }
    if (
      conversation.type === 'GROUP' &&
      !(await this.isCircleModerator(conversation, userId))
    ) {
      throw new ForbiddenException({
        message: '仅圈主或管理员可设置',
        errorCode: GroupErrorCode.ManagerOnly,
      });
    }
    // 单聊拉黑之后座位仍在,不复查的话被拉黑的一方可以把会话设成 30 秒焚毁,
    // 隔一分钟 sweeper 就替他把对方的整段历史真删了 —— 一个连消息都发不出去的
    // 人,不该有销毁对方数据的能力。
    await this.assertDirectMutationAllowed(conversation, userId);
    const normalized =
      seconds !== null && Number.isInteger(seconds) && seconds > 0
        ? seconds
        : null;
    // 放宽/关闭之前,先把旧策略下**已经到期**的消息落成真删。
    // 读路径的过滤是按「当前 burnDurationSec」算的,一旦放宽,那些已经过期、
    // 只是还没轮到 sweeper 的消息会连同签名的媒体 URL 一起重新可读 ——
    // 用户以为烧掉的东西又回来了。
    await this.tombstoneExpiredBeforeRelax(
      conversationId,
      conversation.burnDurationSec,
      normalized,
    );
    // 微信/Signal 式留痕:开关变化必须双方可见,防「对方偷偷开了焚毁」。
    //
    // 设置与痕迹必须在**同一个事务**里。上一版只是把 emit 从 fire-and-forget
    // 改成 await —— 没用:emit 内部就把失败吞成 warn 了,await 一个从不失败的
    // 调用,等于什么都没做。破坏性的保留策略照样能在无人知晓的情况下生效。
    const { updated, notice } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.chatConversation.update({
        where: { id: conversationId },
        data: { burnDurationSec: normalized },
      });
      const dto = await this.systemMessage.insertSystemMessageInTx(
        tx,
        conversationId,
        { kind: 'burn-changed', seconds: normalized ?? 0 },
      );
      return { updated: row, notice: dto };
    });
    // 广播放在提交之后:事务回滚了却已经播出去,客户端会显示一条并不存在的提示。
    this.systemMessage.broadcastSystemMessage(notice);
    return { burnDurationSec: updated.burnDurationSec ?? null };
  }

  /**
   * 焚毁时长放宽/关闭前的兜底真删:按**旧**时长算出的过期消息立刻落成
   * deleted,免得放宽之后它们从读路径的过滤里溜回来。
   * 收紧(新时长更短)不需要处理 —— 新截止只会更晚,sweeper 下一轮就到。
   */
  private async tombstoneExpiredBeforeRelax(
    conversationId: string,
    previousSeconds: number | null,
    nextSeconds: number | null,
  ): Promise<void> {
    if (!previousSeconds || previousSeconds <= 0) return;
    if (nextSeconds !== null && nextSeconds <= previousSeconds) return;
    const cutoff = new Date(Date.now() - previousSeconds * 1000);
    // 分批。刚开了 30 秒焚毁又立刻关掉的长会话,积压可能是整段历史:
    // 一次 findMany 会把每一行的完整 JSON content 都拉进内存,后面再跟一条
    // 巨大的 IN 更新 —— 内存、查询参数上限、接口超时三样一起顶上来。
    for (let round = 0; round < RELAX_PURGE_BATCHES_MAX; round += 1) {
      const expired = await this.prisma.chatMessage.findMany({
        where: {
          conversationID: conversationId,
          deleted: false,
          createdAt: { lt: cutoff },
        },
        select: { id: true, type: true, content: true },
        take: RELAX_PURGE_BATCH,
      });
      if (expired.length === 0) return;
      await this.prisma.chatMessage.updateMany({
        where: { id: { in: expired.map((row) => row.id) } },
        // contentHistory 一并清空:编辑过的消息,历次旧正文都还完整躺在这里,
        // 只清 content 等于「烧掉的只是最后一版」。
        data: {
          deleted: true,
          content: {},
          contentHistory: [] as Prisma.InputJsonValue,
        },
      });
      const mediaKeys = expired.flatMap((row) => this.collectMediaKeys(row));
      if (mediaKeys.length > 0) void this.media.deleteObjects(mediaKeys);
      if (expired.length < RELAX_PURGE_BATCH) return;
    }
    // 批次上限也没清完(异常量级的积压):设置**不放宽**,让读路径继续按旧
    // 截止过滤,剩下的交给每分钟 sweeper。宁可晚点放宽,也不能让已经烧掉的
    // 内容重新可读。
    throw new BadRequestException({
      message: '历史清理中,请稍后再试',
      errorCode: ChatErrorCode.RateLimited,
    });
  }

  /**
   * G-14 清空聊天记录:私聊推进双方成员水位,群聊仅推进发起者水位；都只前进
   * 不后退。消息行保留用于审计/合规,但目标成员的所有设备都无法再读到旧记录。
   * 清空即已读:lastReadHeight 同步推到同一高度。
   */
  async clearHistory(
    userId: string,
    conversationId: string,
    forEveryone = false,
  ): Promise<{ clearedBeforeHeight: number }> {
    const member = await this.requireMembershipSeat(conversationId, userId);
    const top = await this.prisma.chatMessage.aggregate({
      where: { conversationID: conversationId },
      _max: { height: true },
    });
    const watermark = top._max.height ?? 0;
    if (watermark <= 0) return { clearedBeforeHeight: 0 };
    const targetUserIds =
      forEveryone && member.conversation.type === 'DIRECT'
        ? (
            await this.prisma.chatMember.findMany({
              where: { conversationID: conversationId, leftAt: null },
              select: { userID: true },
            })
          ).map((target) => target.userID)
        : [userId];
    await this.prisma.chatMember.updateMany({
      where: {
        conversationID: conversationId,
        userID: { in: targetUserIds },
        clearedBeforeHeight: { lt: watermark },
      },
      data: { clearedBeforeHeight: watermark },
    });
    const read = await this.prisma.chatMember.updateMany({
      where: {
        conversationID: conversationId,
        userID: { in: targetUserIds },
        lastReadHeight: { lt: watermark },
      },
      data: { lastReadHeight: watermark },
    });
    // 清空即已读 —— 但这条路径绕开了网关的 chat:read 广播,于是对端的已读回执
    // 和本账号其他设备的未读红点会一直停在旧水位。既然语义上就是「读到当前最高」,
    // 那就播出和 markRead 完全一样的事件。
    if (read.count > 0) {
      for (const targetUserId of targetUserIds) {
        this.broadcast.emitRead({
          conversationId,
          userId: targetUserId,
          height: watermark,
        });
      }
    }
    if (forEveryone && member.conversation.type === 'DIRECT') {
      this.broadcast.emitHistoryCleared({
        conversationId,
        clearedBeforeHeight: watermark,
        clearedBy: userId,
      });
    }
    return { clearedBeforeHeight: watermark };
  }

  /** GROUP 会话按圈子角色判定管理权(OWNER/ADMIN 且 ACTIVE)。 */
  private async isCircleModerator(
    conversation: ChatConversation,
    userId: string,
  ): Promise<boolean> {
    if (conversation.type !== 'GROUP' || !conversation.circleID) return false;
    const member = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: userId, circleID: conversation.circleID },
      },
      select: { role: true, status: true },
    });
    return (
      !!member &&
      member.status === 'ACTIVE' &&
      (member.role === 'OWNER' || member.role === 'ADMIN')
    );
  }

  /** 媒体消息 content 里的对象 key(撤回时要一并删的那些)。 */
  /**
   * 这条消息**独占**的对象 key —— 调用方拿它去删对象(撤回、阅后即焚清扫)。
   *
   * 笔记导入的 key 是 (viewer, note, media) 的确定性指纹,同一个人把同一张
   * 笔记图发进两个会话会共用同一个对象。删除没有引用计数,所以这类 key 必须
   * 排除:否则撤回其中一条,另一条的图就永久坏掉。这些对象的生命周期跟着
   * 笔记媒体走,不跟着任何一条消息走。
   */
  private collectMediaKeys(row: { type: string; content: unknown }): string[] {
    if (!MEDIA_MESSAGE_TYPES.includes(row.type)) return [];
    const content = (row.content ?? {}) as Record<string, unknown>;
    return ['key', 'thumbKey']
      .map((field) => content[field])
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .filter((key) => !key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`));
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

/**
 * 被引用消息的短摘要(服务端生成,进 replyTo 快照)。
 * 与 chat-push 的预览同一取向:文本截断,媒体/卡片用类型标签,
 * 具体文案的本地化仍由前端词表负责,这里只是兜底展示。
 */
const REPLY_PREVIEW_MAX = 40;
const REPLY_PREVIEW_LABELS: Record<string, string> = {
  image: '[图片]',
  video: '[视频]',
  voice: '[语音]',
  file: '[文件]',
  location: '[位置]',
  'note-card': '[笔记]',
  'friend-card': '[名片]',
  'circle-card': '[圈子]',
  'plaza-post-card': '[帖子]',
  'qr-card': '[二维码]',
  'transfer-card': '[转账]',
  'verification-card': '[验证]',
  'call-record': '[通话]',
};

function previewOfContent(type: string, content: unknown): string {
  const record = (content ?? {}) as Record<string, unknown>;
  if (type === 'text' || type === 'quote') {
    const text = typeof record['text'] === 'string' ? record['text'] : '';
    return text.length > REPLY_PREVIEW_MAX
      ? `${text.slice(0, REPLY_PREVIEW_MAX)}…`
      : text;
  }
  return REPLY_PREVIEW_LABELS[type] ?? '[消息]';
}
