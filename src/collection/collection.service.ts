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
   * 但收藏走的是另一扇门：客户端拼好快照直接 POST，服务端从头到尾没看过那条
   * 消息，于是 chat.service 里的 CHAT_FORWARD_FORBIDDEN 完全够不着它 —— 对端在
   * 焚毁会话里发的图，点一下「收藏」就永久留下了。这里按 payload 带回来的
   * messageID 把消息捞回来，补上同一条判定。
   *
   * 三种情况刻意放行：
   * - payload 里没有 messageID（笔记、纯文本片段等）：不在这条规则的射程内。
   * - 库里查不到那个 id：客户端本地占位（`local:<d>`）还没换成服务端 id，
   *   拦它只会误伤自己刚发出去的消息。
   * - 自己发的：与转发口径一致，那是你自己的内容，重发一次效果完全一样。
   */
  private async assertCollectable(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<void> {
    const rawMessageId = dto.payload?.['messageID'];
    if (typeof rawMessageId !== 'string' || rawMessageId.length === 0) return;

    const row = await this.prisma.chatMessage.findUnique({
      where: { id: rawMessageId },
      select: {
        senderID: true,
        conversation: { select: { burnDurationSec: true } },
      },
    });
    if (!row || row.senderID === userId) return;
    if (!row.conversation?.burnDurationSec) return;

    throw new ForbiddenException({
      message: '阅后即焚会话中的消息不可收藏',
      errorCode: CollectionErrorCode.EphemeralForbidden,
    });
  }

  async create(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<UserCollectionDto> {
    await this.assertCollectable(userId, dto);
    const data: Prisma.UserCollectionUncheckedCreateInput = {
      userID: userId,
      type: dto.type,
      title: dto.title,
      summary: dto.summary,
      sourceID: dto.sourceID,
      payload: dto.payload as Prisma.InputJsonValue | undefined,
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
