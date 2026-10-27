import * as argon2 from 'argon2';
import { Prisma } from 'src/generated/prisma';
import {
  generateUniqueRegistrationCode,
  isAccountIdentifierClaimCollision,
} from 'src/auth/account-id.unique';
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
import {
  AdminListRow,
  buildAdminListCountQuery,
  buildAdminListPageQuery,
} from './admin-access-list.query';
import {
  AdminAccountAvailabilityQuery,
  DeleteAdminAccountDto,
  CreateAdminAccountDto,
  ResetAdminPasswordDto,
  AdminPageQuery,
  UpdateAdminAccessDto,
} from './admin-access.dto';

@Injectable()
export class AdminAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async availability(query: AdminAccountAvailabilityQuery) {
    const accountId = query.accountId.trim().toLowerCase();
    const [user, identifier] = await Promise.all([
      this.prisma.user.findUnique({
        where: { accountId },
        select: { id: true },
      }),
      this.prisma.accountIdentifier.findUnique({
        where: { value: accountId },
        select: { value: true, currentUserID: true },
      }),
    ]);
    const ownCurrentAccount =
      !!query.excludeUserId && user?.id === query.excludeUserId;
    return {
      available:
        (!user || ownCurrentAccount) &&
        (!identifier ||
          (ownCurrentAccount &&
            identifier.currentUserID === query.excludeUserId)),
    };
  }

  async create(actorID: string, dto: CreateAdminAccountDto) {
    const accountId = dto.accountId.trim().toLowerCase();
    const passwordHash = await argon2.hash(dto.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(72419930)`;
        const actor = await tx.user.findUnique({
          where: { id: actorID },
          select: { role: true, status: true, adminAccess: true },
        });
        if (
          actor?.role !== 'ADMIN' ||
          actor.status !== 'ACTIVE' ||
          actor.adminAccess?.role !== 'SUPER_ADMIN'
        )
          throw new ForbiddenException('仅超级管理员可新增管理员');
        if (
          (await tx.user.findUnique({
            where: { accountId },
            select: { id: true },
          })) ||
          (await tx.accountIdentifier.findUnique({
            where: { value: accountId },
            select: { value: true },
          }))
        )
          throw new ConflictException('该登录账号已被使用，请更换账号');
        const inviteCode = await generateUniqueRegistrationCode(tx);
        const user = await tx.user.create({
          data: {
            email: null,
            nickname: dto.nickname,
            passwordHash,
            accountId,
            inviteCode,
            role: 'ADMIN',
            status: 'ACTIVE',
            mustChangePassword: false,
            adminAccess: { create: { role: dto.role } },
          },
          select: { id: true, nickname: true, accountId: true },
        });
        await tx.adminAuditLog.create({
          data: {
            actorID,
            action: 'admin.account.create',
            entityType: 'user',
            entityID: user.id,
            after: { role: dto.role },
            requestId: getRequestContext()?.requestId,
          },
        });
        return user;
      });
    } catch (error) {
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002') ||
        isAccountIdentifierClaimCollision(error, [accountId])
      )
        throw new ConflictException('登录账号已被使用，请更换账号');
      throw error;
    }
  }

  async resetPassword(
    actorID: string,
    userID: string,
    dto: ResetAdminPasswordDto,
  ) {
    const passwordHash = await argon2.hash(dto.newPassword);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(72419930)`;
      const lockKey = `auth-user:${userID}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const actor = await tx.user.findUnique({
        where: { id: actorID },
        select: { role: true, status: true, adminAccess: true },
      });
      if (
        actor?.role !== 'ADMIN' ||
        actor.status !== 'ACTIVE' ||
        actor.adminAccess?.role !== 'SUPER_ADMIN'
      )
        throw new ForbiddenException('仅超级管理员可设置管理员密码');
      const target = await tx.user.findUnique({
        where: { id: userID },
        select: { role: true, status: true },
      });
      if (target?.role !== 'ADMIN' || target.status !== 'ACTIVE')
        throw new NotFoundException('未找到可用管理员');
      const now = new Date();
      const result = await tx.user.updateMany({
        where: { id: userID, role: 'ADMIN', status: 'ACTIVE' },
        data: {
          passwordHash,
          mustChangePassword: false,
          accessTokensRevokedAt: now,
        },
      });
      if (!result.count)
        throw new ConflictException('账号状态已变化，请刷新后重试');
      await tx.refreshToken.updateMany({
        where: { userId: userID, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.adminAuditLog.create({
        data: {
          actorID,
          action: 'admin.password.reset',
          entityType: 'user',
          entityID: userID,
          reason: dto.reason,
          requestId: getRequestContext()?.requestId,
        },
      });
      return { changed: true };
    });
  }

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

  async updateNickname(userID: string, nickname: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userID, role: 'ADMIN', status: 'ACTIVE' },
        select: { id: true, nickname: true, accountId: true },
      });
      if (!user) throw new ForbiddenException('当前管理员不可用');
      const changed = await tx.user.updateMany({
        where: { id: userID, role: 'ADMIN', status: 'ACTIVE' },
        data: { nickname },
      });
      if (!changed.count) throw new ForbiddenException('当前管理员不可用');
      await tx.adminAuditLog.create({
        data: {
          actorID: userID,
          actorAccountId: user.accountId,
          action: 'admin.nickname.update',
          entityType: 'user',
          entityID: userID,
          before: { nickname: user.nickname },
          after: { nickname },
          requestId: getRequestContext()?.requestId,
        },
      });
      return { id: userID, nickname };
    });
  }

  async list(query: AdminPageQuery) {
    // 原生 SQL:role/status 写成字面量才能用上只收管理员的部分索引,
    // 筛选口径与原 Prisma 查询一致,见 admin-access-list.query.ts。
    const [rows, counted] = await this.prisma.$transaction([
      this.prisma.$queryRaw<AdminListRow[]>(
        buildAdminListPageQuery({
          search: query.search,
          limit: query.limit,
          offset: (query.page - 1) * query.limit,
        }),
      ),
      this.prisma.$queryRaw<Array<{ total: number }>>(
        buildAdminListCountQuery({ search: query.search }),
      ),
    ]);
    return {
      items: rows.map(({ consoleRole, version, ...user }) => ({
        ...user,
        consoleRole: consoleRole ?? null,
        version: version ?? 0,
      })),
      total: counted[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async update(actorID: string, userID: string, dto: UpdateAdminAccessDto) {
    return this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(72419930)`;
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
          select: {
            id: true,
            role: true,
            status: true,
            adminAccess: true,
            nickname: true,
            accountId: true,
          },
        });
        if (!target || target.role !== 'ADMIN' || target.status !== 'ACTIVE')
          throw new NotFoundException('未找到可用管理员');
        if (actorID === userID && dto.role !== target.adminAccess?.role)
          throw new BadRequestException('不能修改自己的管理员角色');
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
        const accountId = dto.accountId?.trim().toLowerCase();
        if (accountId && accountId !== target.accountId) {
          const claimed = await tx.accountIdentifier.findUnique({
            where: { value: accountId },
            select: { value: true },
          });
          if (
            claimed ||
            (await tx.user.findUnique({
              where: { accountId },
              select: { id: true },
            }))
          )
            throw new ConflictException('登录账号已被使用，请更换账号');
        }
        const credentialsChanged =
          (!!accountId && accountId !== target.accountId) ||
          dto.role !== target.adminAccess?.role;
        const now = new Date();
        if (credentialsChanged) {
          const lockKey = `auth-user:${userID}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        }
        if (
          dto.nickname !== undefined ||
          dto.accountId !== undefined ||
          credentialsChanged
        ) {
          await tx.user.update({
            where: { id: userID },
            data: {
              ...(dto.nickname !== undefined ? { nickname: dto.nickname } : {}),
              ...(accountId ? { accountId } : {}),
              ...(credentialsChanged ? { accessTokensRevokedAt: now } : {}),
            },
          });
        }
        if (credentialsChanged)
          await tx.refreshToken.updateMany({
            where: { userId: userID, revokedAt: null },
            data: { revokedAt: now },
          });
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
            before: {
              role: target.adminAccess?.role ?? null,
              nickname: target.nickname,
              accountId: target.accountId,
            },
            after: {
              role: dto.role,
              nickname: dto.nickname ?? target.nickname,
              accountId: accountId ?? target.accountId,
            },
            reason: dto.reason,
            requestId: context?.requestId,
          },
        });
        return { role: result.role, version: result.version };
      })
      .catch((error) => {
        if (
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002') ||
          isAccountIdentifierClaimCollision(error, [dto.accountId])
        )
          throw new ConflictException('登录账号已被使用，请更换账号');
        throw error;
      });
  }
  async remove(actorID: string, userID: string, dto: DeleteAdminAccountDto) {
    if (actorID === userID)
      throw new BadRequestException('不能删除当前登录的管理员');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(72419930)`;
      const lockKey = `auth-user:${userID}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const actor = await tx.user.findUnique({
        where: { id: actorID },
        select: { role: true, status: true, adminAccess: true },
      });
      if (
        actor?.role !== 'ADMIN' ||
        actor.status !== 'ACTIVE' ||
        actor.adminAccess?.role !== 'SUPER_ADMIN'
      )
        throw new ForbiddenException('仅超级管理员可删除管理员');
      const target = await tx.user.findUnique({
        where: { id: userID },
        select: { id: true, role: true, status: true, adminAccess: true },
      });
      if (target?.role !== 'ADMIN' || target.status === 'DELETED')
        throw new NotFoundException('未找到可用管理员');
      if ((target.adminAccess?.version ?? 0) !== dto.version)
        throw new ConflictException('管理员资料已变化，请刷新后重试');
      if (
        target.status === 'ACTIVE' &&
        target.adminAccess?.role === 'SUPER_ADMIN' &&
        (await tx.adminAccess.count({
          where: {
            role: 'SUPER_ADMIN',
            user: { role: 'ADMIN', status: 'ACTIVE' },
          },
        })) <= 1
      )
        throw new BadRequestException('必须保留至少一个可用超级管理员');
      const now = new Date();
      await tx.user.update({
        where: { id: userID },
        data: { status: 'DELETED', accessTokensRevokedAt: now },
      });
      await tx.refreshToken.updateMany({
        where: { userId: userID, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.adminAuditLog.create({
        data: {
          actorID,
          action: 'admin.account.delete',
          entityType: 'user',
          entityID: userID,
          reason: dto.reason,
          requestId: getRequestContext()?.requestId,
        },
      });
      return { deleted: true };
    });
  }
}
