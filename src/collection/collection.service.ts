import { Injectable, NotFoundException } from '@nestjs/common';
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

  create(userId: string, dto: CreateCollectionDto): Promise<UserCollectionDto> {
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
      throw new NotFoundException('Collection not found');
    }
  }
}
