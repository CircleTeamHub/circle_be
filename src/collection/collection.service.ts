import {
  BadRequestException,
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

  async create(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<UserCollectionDto> {
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
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`collection:${userId}`}))`;
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
