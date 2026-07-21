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
    // #104 审查发现：与 share-link 同类的无界增长面。500 远超正常收藏量，
    // 到顶提示先清理（list 本身 take 100，超过后旧收藏本就翻不到）。
    const existing = await this.prisma.userCollection.count({
      where: { userID: userId },
    });
    if (existing >= 500) {
      throw new BadRequestException({
        message: '收藏数量已达上限，请先清理不再需要的收藏',
        errorCode: CollectionErrorCode.Limit,
      });
    }

    const data: Prisma.UserCollectionUncheckedCreateInput = {
      userID: userId,
      type: dto.type,
      title: dto.title,
      summary: dto.summary,
      sourceID: dto.sourceID,
      payload: dto.payload as Prisma.InputJsonValue | undefined,
    };

    return this.prisma.userCollection.create({ data });
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
