import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  sanitizeFriendCardContent,
  sanitizeTransferCardContent,
} from 'src/chat/chat-card-content';
import { messagePreviewText } from 'src/chat/chat-message-preview';
import { ChatService } from 'src/chat/chat.service';
import { CollectionErrorCode } from 'src/common/app-error-codes';
import { CollectionType, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCollectionDto, UserCollectionDto } from './dto/collection.dto';

/** 与 CreateCollectionDto 上 summary 的 @MaxLength 一致:派生值也得进得去同一列。 */
const SUMMARY_MAX = 240;
/** 空正文的文本消息没有可派生的标题,给一个占位而不是落一条空标题。 */
const UNTITLED = '[消息]';
/** 载荷里的展示用元数据(会话名/发送者名)的长度上限。 */
const LABEL_MAX = 60;
const SOURCE_ID_MAX = 120;
/** 前端 ConversationType 的全部取值。 */
const CONVERSATION_TYPES = new Set(['group', 'private']);

@Injectable()
export class CollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  private invalidMessageSource(): never {
    throw new BadRequestException({
      message: '收藏的消息来源无效或不可访问',
      errorCode: CollectionErrorCode.InvalidMessageSource,
    });
  }

  list(userId: string, type?: CollectionType): Promise<UserCollectionDto[]> {
    return this.prisma.userCollection.findMany({
      where: { userID: userId, ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * 「这条消息现在还能不能被我看到」的判定,直接借 chat 那把尺子
   * (ChatService.requireVisibleMessage:未删/未撤回 + 仍在座 + 高于清空水位 +
   * 未过自动销毁/焚毁窗口)。收藏一度自己写了个弱化版,只看 member.leftAt,于是
   * 清空过的历史、早该烧掉的消息都还能收藏进来 —— 同一个问题不能有两把尺子。
   *
   * chat 侧抛 404(不可见)/403(不在座),对收藏来说都是同一件事:客户端报的
   * 来源不成立。统一收敛成 COLLECTION_INVALID_MESSAGE_SOURCE,不把 chat 的错误码
   * 漏成收藏接口的契约。
   */
  private async requireVisibleMessage(userId: string, messageId: string) {
    try {
      return await this.chat.requireVisibleMessage(userId, messageId);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        this.invalidMessageSource();
      }
      throw error;
    }
  }

  /**
   * 收藏 = 把这条消息永久留在自己的列表里。转发那道闸的理由在这里一字不差地
   * 成立：阅后即焚会话的短暂性是**发送者对收件人的承诺**，把别人发的内容复制进
   * 一个不会过期的地方，副本就活得比源消息久。
   *
   * 但收藏走的是另一扇门：客户端拼好快照直接 POST，chat.service 里的
   * CHAT_FORWARD_FORBIDDEN 完全够不着它。这里把 messageID 当作引用而不是证据：
   * 只查询当前用户仍可访问的服务端消息，并从那一行重建所有内容字段，避免客户端
   * 用一条普通消息的 id 搭配另一条焚毁消息的快照蒙混过关。
   *
   * 标题与摘要同样由服务端从已验证的内容派生 —— 它们不是「元数据」而是正文的
   * 副本:客户端自报的 summary 会被收藏页展示、还会被重发兜底当成消息正文发出去
   * (resolveCollectionSendPlan 在 payload.text 为空时读 summary/title)。收藏
   * 一条自己的普通消息、把对方焚毁消息的原文填进 summary,就绕开了上面那道闸。
   *
   * 非聊天收藏不走这条校验。聊天收藏缺 id、id 不存在/不可见、sourceID 不一致时
   * 一律失败关闭；自己的焚毁消息仍允许收藏，与转发口径一致。
   */
  private async verifiedMessageSnapshot(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<{
    sourceID: string | undefined;
    payload: Prisma.InputJsonValue | undefined;
    title: string;
    summary: string | undefined;
  }> {
    const rawPayload = dto.payload;
    const rawMessageId = dto.payload?.['messageID'];
    const isMessageCollection =
      dto.type !== CollectionType.NOTE ||
      rawPayload?.['kind'] === 'openim-message';
    if (!isMessageCollection) {
      return {
        sourceID: dto.sourceID,
        payload: rawPayload as Prisma.InputJsonValue | undefined,
        title: dto.title,
        summary: dto.summary,
      };
    }
    if (
      rawPayload?.['kind'] !== 'openim-message' ||
      typeof rawMessageId !== 'string' ||
      rawMessageId.length === 0 ||
      dto.sourceID !== rawMessageId
    ) {
      return this.invalidMessageSource();
    }

    const { row, conversation } = await this.requireVisibleMessage(
      userId,
      rawMessageId,
    );

    if (row.senderID !== userId && Boolean(conversation.burnDurationSec)) {
      throw new ForbiddenException({
        message: '阅后即焚会话中的消息不可收藏',
        errorCode: CollectionErrorCode.EphemeralForbidden,
      });
    }

    const rawContent = row.content;
    const content =
      rawContent && typeof rawContent === 'object' && !Array.isArray(rawContent)
        ? (rawContent as Record<string, unknown>)
        : {};
    let messageType: string = row.type;
    if (row.type === 'text' || row.type === 'quote') {
      messageType = row.senderID === userId ? 'sent' : 'received';
    }
    const payload: Record<string, unknown> = {
      kind: 'openim-message',
      messageID: row.id,
      messageType,
      conversationID: row.conversationID,
      time: row.createdAt.toISOString(),
    };
    if (row.senderID && row.senderID !== userId) {
      payload.senderID = row.senderID;
    }

    // 展示用元数据(会话名 / 发送者名 / 跳转用的来源 id)服务端无法从消息行重建,
    // 仍旧透传;但它们同样是对端可控的自由文本,按展示位的宽度封顶,别让一段正文
    // 借这些字段整条搬进收藏。
    const label = (value: unknown, cap: number): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const text = value.trim();
      if (!text) return undefined;
      return text.length > cap ? text.slice(0, cap) : text;
    };
    const conversationTitle = label(rawPayload['conversationTitle'], LABEL_MAX);
    if (conversationTitle) payload.conversationTitle = conversationTitle;
    const senderName = label(rawPayload['senderName'], LABEL_MAX);
    if (senderName) payload.senderName = senderName;
    const sourceID = label(rawPayload['sourceID'], SOURCE_ID_MAX);
    if (sourceID) payload.sourceID = sourceID;
    const conversationType = rawPayload['conversationType'];
    if (
      typeof conversationType === 'string' &&
      CONVERSATION_TYPES.has(conversationType)
    ) {
      payload.conversationType = conversationType;
    }

    if (row.type === 'text' || row.type === 'quote') {
      payload.text = typeof content['text'] === 'string' ? content['text'] : '';
    } else if (row.type === 'image') {
      // content 的真实形状是 {key,url?,thumbUrl?,width?,height?}:url 是读时现签的
      // 临时地址(存下来必然过期),能长期指回这张图的只有 key。
      const image: Record<string, unknown> = {};
      if (typeof content['key'] === 'string') image.key = content['key'];
      if (typeof content['width'] === 'number') image.width = content['width'];
      if (typeof content['height'] === 'number')
        image.height = content['height'];
      payload.image = image;
    } else if (row.type === 'voice') {
      // 语音 content 只有 {key,duration}(url 同样是读时现签)。此前这里还从
      // content.size 映射 dataSize —— 语音消息从来没有这个字段,是条死分支。
      const voice: Record<string, unknown> = {};
      if (typeof content['key'] === 'string') voice.key = content['key'];
      if (typeof content['duration'] === 'number') {
        voice.duration = content['duration'];
      }
      payload.voice = voice;
    } else if (row.type === 'friend-card') {
      // 卡片 content 由发送方构造、发送路径不校验形状。整份照搬等于把一条没消过毒
      // 的载荷存进收藏,而「从收藏重发」会把它原样当成新消息的 content 发出去。
      payload.friendCard = sanitizeFriendCardContent(content);
    } else if (row.type === 'transfer-card') {
      payload.transferCard = sanitizeTransferCardContent(content);
    }

    // 标题走引用快照同一个截断长度(40),摘要给到 DTO 的上限。
    const derived = messagePreviewText(row.type, content, SUMMARY_MAX);
    const title = messagePreviewText(row.type, content) || UNTITLED;
    return {
      sourceID: row.id,
      payload: payload as Prisma.InputJsonValue,
      title,
      // 文本类摘要就是正文本身(已由服务端截断);其余类型的标签已经在 title 里,
      // 再抄一遍只是把同一行字显示两次。
      summary: derived && derived !== title ? derived : undefined,
    };
  }

  async create(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<UserCollectionDto> {
    const verified = await this.verifiedMessageSnapshot(userId, dto);
    const data: Prisma.UserCollectionUncheckedCreateInput = {
      userID: userId,
      type: dto.type,
      title: verified.title,
      summary: verified.summary,
      sourceID: verified.sourceID,
      payload: verified.payload,
    };

    // #104 审查发现：与 share-link 同类的无界增长面。500 远超正常收藏量，
    // 到顶提示先清理（list 本身 take 100，超过后旧收藏本就翻不到）。
    // round 2 review：count+create 用 per-user advisory 锁串行化（与
    // note share-link 同款）—— 499 时并发 N 发不再全部越过上限。
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`collection:${userId}`}))`;
      const existing = await tx.userCollection.count({
        where: { userID: userId },
      });
      if (existing >= 500) {
        throw new BadRequestException({
          message: '收藏数量已达上限，请先清理不再需要的收藏',
          errorCode: CollectionErrorCode.Limit,
        });
      }
      return tx.userCollection.create({ data });
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.userCollection.deleteMany({
      where: { id, userID: userId },
    });
    if (result.count !== 1) {
      throw new NotFoundException({
        message: 'Collection not found',
        errorCode: CollectionErrorCode.NotFound,
      });
    }
  }
}
