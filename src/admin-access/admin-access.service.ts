import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { getRequestContext } from 'src/logging/request-context';
import { ADMIN_ROLE_PERMISSIONS } from './admin-permission.guard';
import { AdminPageQuery, UpdateAdminAccessDto } from './admin-access.dto';

@Injectable()
export class AdminAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getMine(userID: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userID },
      select: { role: true, status: true, adminAccess: true },
    });
    if (user?.role !== 'ADMIN' || user.status !== 'ACTIVE' || !user.adminAccess)
      throw new ForbiddenException('管理员尚未分配权限');
    return {
      role: user.adminAccess.role,
      permissions: ADMIN_ROLE_PERMISSIONS[user.adminAccess.role] ?? [],
      version: user.adminAccess.version,
    };
  }

  async list(query: AdminPageQuery) {
    const where = {
      role: 'ADMIN' as const,
      ...(query.search
        ? {
            OR: [
              {
                accountId: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                nickname: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          accountId: true,
          nickname: true,
          status: true,
          adminAccess: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: rows.map(({ adminAccess, ...user }) => ({
        ...user,
        consoleRole: adminAccess?.role ?? null,
        version: adminAccess?.version ?? 0,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async update(actorID: string, userID: string, dto: UpdateAdminAccessDto) {
    if (actorID === userID)
      throw new BadRequestException('不能修改自己的管理员角色');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(72419930)`;
      const actor = await tx.user.findUnique({
        where: { id: actorID },
        select: { role: true, status: true, adminAccess: true },
      });
      if (
        actor?.role !== 'ADMIN' ||
        actor.status !== 'ACTIVE' ||
        actor.adminAccess?.role !== 'SUPER_ADMIN'
      )
        throw new ForbiddenException('无权限分配管理员角色');
      const target = await tx.user.findUnique({
        where: { id: userID },
        select: { id: true, role: true, status: true, adminAccess: true },
      });
      if (!target || target.role !== 'ADMIN' || target.status !== 'ACTIVE')
        throw new NotFoundException('未找到可用管理员');
      if ((target.adminAccess?.version ?? 0) !== dto.version)
        throw new ConflictException('管理员权限已变化，请刷新后重试');
      if (
        target.adminAccess?.role === 'SUPER_ADMIN' &&
        dto.role !== 'SUPER_ADMIN'
      ) {
        const activeSuperAdmins = await tx.adminAccess.count({
          where: {
            role: 'SUPER_ADMIN',
            user: { status: 'ACTIVE', role: 'ADMIN' },
          },
        });
        if (activeSuperAdmins <= 1)
          throw new BadRequestException('必须保留至少一个可用超级管理员');
      }
      const result = await tx.adminAccess.upsert({
        where: { userID },
        create: { userID, role: dto.role },
        update: { role: dto.role, version: { increment: 1 } },
      });
      const context = getRequestContext();
      await tx.adminAuditLog.create({
        data: {
          actorID,
          action: 'admin_access.update',
          entityType: 'admin_access',
          entityID: userID,
          before: { role: target.adminAccess?.role ?? null },
          after: { role: dto.role },
          reason: dto.reason,
          requestId: context?.requestId,
        },
      });
      return { role: result.role, version: result.version };
    });
  }
}
