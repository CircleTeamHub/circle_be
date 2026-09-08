import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectionErrorCode } from 'src/common/app-error-codes';
import { CollectionType, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCollectionDto, UserCollectionDto } from './dto/collection.dto';

@Injectable()
export class CollectionService {
  constructor(private readonly prisma: PrismaService) {}

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
   * 收藏 = 把这条消息永久留在自己的列表里。转发那道闸的理由在这里一字不差地
   * 成立：阅后即焚会话的短暂性是**发送者对收件人的承诺**，把别人发的内容复制进
   * 一个不会过期的地方，副本就活得比源消息久。
   *
   * 但收藏走的是另一扇门：客户端拼好快照直接 POST，chat.service 里的
   * CHAT_FORWARD_FORBIDDEN 完全够不着它。这里把 messageID 当作引用而不是证据：
   * 只查询当前用户仍可访问的服务端消息，并从那一行重建所有内容字段，避免客户端
   * 用一条普通消息的 id 搭配另一条焚毁消息的快照蒙混过关。
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

    const row = await this.prisma.chatMessage.findFirst({
      where: {
        id: rawMessageId,
        deleted: false,
        revokedAt: null,
        conversation: {
          members: { some: { userID: userId, leftAt: null } },
        },
      },
      select: {
        id: true,
        conversationID: true,
        senderID: true,
        type: true,
        content: true,
        createdAt: true,
        conversation: { select: { burnDurationSec: true } },
      },
    });
    if (!row) return this.invalidMessageSource();

    if (row.senderID !== userId && Boolean(row.conversation?.burnDurationSec)) {
      throw new ForbiddenException({
        message: '阅后即焚会话中的消息不可收藏',
        errorCode: CollectionErrorCode.EphemeralForbidden,
      });
    }

    const content = (row.content ?? {}) as Record<string, unknown>;
    let messageType = row.type;
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

    for (const key of [
      'conversationTitle',
      'sourceID',
      'conversationType',
      'senderName',
    ]) {
      const value = rawPayload[key];
      if (typeof value === 'string') payload[key] = value;
    }

    if (row.type === 'text' || row.type === 'quote') {
      payload.text = typeof content['text'] === 'string' ? content['text'] : '';
    } else if (row.type === 'image') {
      const image: Record<string, unknown> = {};
      if (typeof content['width'] === 'number') image.width = content['width'];
      if (typeof content['height'] === 'number')
        image.height = content['height'];
      payload.image = image;
    } else if (row.type === 'voice') {
      const voice: Record<string, unknown> = {};
      if (typeof content['key'] === 'string') voice.key = content['key'];
      if (typeof content['duration'] === 'number') {
        voice.duration = content['duration'];
      }
      if (typeof content['size'] === 'number') voice.dataSize = content['size'];
      payload.voice = voice;
    } else if (row.type === 'friend-card') {
      payload.friendCard = content;
    } else if (row.type === 'transfer-card') {
      payload.transferCard = content;
    }

    return {
      sourceID: row.id,
      payload: payload as Prisma.InputJsonValue,
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
      title: dto.title,
      summary: dto.summary,
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
