import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuditQuery } from './admin-operations.dto';

@Injectable()
export class AdminAuditQueryService {
  constructor(private readonly prisma: PrismaService) {}
  async list(query: AuditQuery) {
    if (query.from && query.to && new Date(query.from) > new Date(query.to))
      throw new BadRequestException('开始时间不能晚于结束时间');
    const where = {
      ...(query.actorID ? { actorID: query.actorID } : {}),
      ...(query.action
        ? { action: { contains: query.action, mode: 'insensitive' as const } }
        : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityID ? { entityID: query.entityID } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.findMany({
        where,
        select: {
          id: true,
          actorID: true,
          actorAccountId: true,
          action: true,
          entityType: true,
          entityID: true,
          reason: true,
          requestId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    const operators = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(items.map((item) => item.actorID))] } },
      select: { id: true, accountId: true, nickname: true },
    });
    return {
      items: items.map((item) => ({
        ...item,
        operator: operators.find((user) => user.id === item.actorID) ?? null,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }
}
