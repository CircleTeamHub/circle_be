import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminPageQuery } from 'src/admin-access/admin-access.dto';
import {
  AdvertisementDto,
  UpdateAdvertisementDto,
} from './admin-operations.dto';
import {
  runAdminOperation,
  writeOperationAudit,
} from './admin-operation-request';

function isPublicHttpsUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) &&
      !/^[\d.]+$/.test(host) &&
      !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(
        host,
      )
    );
  } catch {
    return false;
  }
}

function validateAdvertisement(dto: AdvertisementDto) {
  if (new Date(dto.endsAt) <= new Date(dto.startsAt))
    throw new BadRequestException('结束时间必须晚于开始时间');
  for (const value of [dto.imageUrl, dto.targetUrl]) {
    if (!isPublicHttpsUrl(value))
      throw new BadRequestException('广告地址需使用公开 HTTPS 链接');
  }
}

@Injectable()
export class AdminAdvertisementService {
  constructor(private readonly prisma: PrismaService) {}
  async list(query: AdminPageQuery) {
    const where = query.search
      ? { title: { contains: query.search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.adminAdvertisement.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.adminAdvertisement.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }
  async published(placement: string) {
    const now = new Date();
    const items = await this.prisma.adminAdvertisement.findMany({
      where: {
        placement,
        enabled: true,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      select: {
        id: true,
        title: true,
        imageUrl: true,
        targetUrl: true,
        startsAt: true,
        endsAt: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    // Isolate legacy invalid configuration before returning the bounded public array.
    // Database primary keys retain uniqueness; the App still checks the envelope.
    return items.filter(
      (item) =>
        item.id.length > 0 &&
        item.title.trim().length > 0 &&
        item.title.length <= 200 &&
        isPublicHttpsUrl(item.imageUrl) &&
        isPublicHttpsUrl(item.targetUrl) &&
        [item.startsAt, item.endsAt].every(
          (date) =>
            Number.isFinite(date.getTime()) &&
            date.getUTCFullYear() >= 0 &&
            date.getUTCFullYear() <= 9999,
        ) &&
        item.startsAt < item.endsAt,
    );
  }
  create(actorID: string, dto: AdvertisementDto, key?: string) {
    validateAdvertisement(dto);
    const { reason, startsAt, endsAt, ...data } = dto;
    return runAdminOperation(
      this.prisma,
      actorID,
      'advertisement.create',
      key,
      dto,
      async (tx) => {
        const result = await tx.adminAdvertisement.create({
          data: {
            ...data,
            startsAt: new Date(startsAt),
            endsAt: new Date(endsAt),
          },
        });
        await writeOperationAudit(
          tx,
          actorID,
          'advertisement.create',
          'advertisement',
          result.id,
          reason,
          undefined,
          { enabled: result.enabled, placement: result.placement },
        );
        return result;
      },
    );
  }
  update(actorID: string, id: string, dto: UpdateAdvertisementDto) {
    validateAdvertisement(dto);
    const { reason, version, startsAt, endsAt, ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.adminAdvertisement.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('广告不存在');
      const result = await tx.adminAdvertisement.updateMany({
        where: { id, version },
        data: {
          ...data,
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
          version: { increment: 1 },
        },
      });
      if (result.count !== 1)
        throw new ConflictException('广告已被其他管理员修改，请刷新后重试');
      await writeOperationAudit(
        tx,
        actorID,
        'advertisement.update',
        'advertisement',
        id,
        reason,
        { enabled: before.enabled, placement: before.placement },
        { enabled: dto.enabled, placement: dto.placement },
      );
      return tx.adminAdvertisement.findUnique({ where: { id } });
    });
  }
}
