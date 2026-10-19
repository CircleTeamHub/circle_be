import { withDatabaseWorkBudget } from 'src/utils/database-work-budget';
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  ADMIN_PERMISSION_KEY,
  ADMIN_ROLE_PERMISSIONS,
  type AdminPermission,
} from 'src/admin-access/admin-permission.guard';
import { getRequestContext } from 'src/logging/request-context';
import {
  runAdminOperation,
  writeOperationAudit,
} from 'src/admin-operations/admin-operation-request';
import type { CreateKeyDto, ReasonDto } from './console.dto';

export const KEY_SCOPE_PERMISSIONS: Record<string, AdminPermission> = {
  tasks: 'DASHBOARD',
  push: 'SUPPORT_MANAGE',
  timeline: 'USER_READ',
  analytics: 'DASHBOARD',
  diagnostics: 'AUDIT_READ',
};
export const ConsoleScope = (scope: string) =>
  SetMetadata('console:scope', scope);
const KEY_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdAt: true,
} as const;
@Injectable()
export class ConsoleKeysService {
  constructor(private readonly prisma: PrismaService) {}
  async list(userID: string) {
    return {
      items: await this.prisma.consoleApiKey.findMany({
        where: { userID },
        select: KEY_SELECT,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  }
  async create(userID: string, dto: CreateKeyDto) {
    // Secret issuance intentionally has no replay store: plaintext appears only in this response.
    const secret = `cak_${randomBytes(32).toString('base64url')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userID} FOR UPDATE`;
      const count = await tx.consoleApiKey.count({
        where: { userID, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (count >= 20)
        throw new BadRequestException('最多同时保留 20 把有效密钥');
      const created = await tx.consoleApiKey.create({
        data: {
          userID,
          name: dto.name,
          prefix: secret.slice(0, 10),
          secretHash,
          scopes: dto.scopes,
          expiresAt: new Date(Date.now() + dto.days * 86400_000),
        },
        select: KEY_SELECT,
      });
      await writeOperationAudit(
        tx,
        userID,
        'console.key.create',
        'api_key',
        created.id,
        dto.reason,
        undefined,
        { scopes: dto.scopes, expiresAt: created.expiresAt.toISOString() },
      );
      return created;
    });
    return { ...row, secret };
  }
  revoke(userID: string, id: string, dto: ReasonDto, key?: string) {
    return runAdminOperation(
      this.prisma,
      userID,
      'key.revoke',
      key,
      { id, ...dto },
      async (tx) => {
        const changed = await tx.consoleApiKey.updateMany({
          where: { id, userID },
          data: { revokedAt: new Date() },
        });
        if (!changed.count) throw new BadRequestException('密钥不存在');
        await writeOperationAudit(
          tx,
          userID,
          'console.key.revoke',
          'api_key',
          id,
          dto.reason,
        );
        return { revoked: true };
      },
    );
  }
}

@Injectable()
export class ConsoleKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    try {
      return await withDatabaseWorkBudget(this.prisma, () =>
        this.authenticate(context),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        ['Authentication is busy', 'Authentication queue timed out'].includes(
          error.message,
        )
      )
        throw new ServiceUnavailableException('工具鉴权繁忙，请稍后重试');
      throw error;
    }
  }
  private async authenticate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const authorization = req.headers.authorization;
    const secret =
      typeof authorization === 'string'
        ? authorization.replace(/^Bearer /, '')
        : '';
    if (!/^cak_[A-Za-z0-9_-]{43}$/.test(secret))
      throw new UnauthorizedException('工具密钥无效');
    const key = await this.prisma.consoleApiKey.findUnique({
      where: { secretHash: createHash('sha256').update(secret).digest('hex') },
      include: {
        user: {
          select: {
            id: true,
            role: true,
            status: true,
            adminAccess: { select: { role: true } },
          },
        },
      },
    });
    const permission = this.reflector.getAllAndOverride<AdminPermission>(
      ADMIN_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    const scope = this.reflector.get<string>(
      'console:scope',
      context.getHandler(),
    );
    const allowed =
      key &&
      !key.revokedAt &&
      key.expiresAt > new Date() &&
      key.user.role === 'ADMIN' &&
      key.user.status === 'ACTIVE' &&
      key.user.adminAccess &&
      permission &&
      ADMIN_ROLE_PERMISSIONS[key.user.adminAccess.role]?.includes(permission) &&
      scope &&
      key.scopes.includes(scope) &&
      KEY_SCOPE_PERMISSIONS[scope] === permission;
    if (!allowed || !key)
      throw new UnauthorizedException('工具密钥无效或当前权限不足');
    req.user = {
      userId: key.userID,
      role: 'ADMIN',
      audience: 'ADMIN',
      accountId: '',
    };
    const diagnostic = getRequestContext();
    await this.prisma.$transaction([
      this.prisma.consoleApiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      }),
      this.prisma.adminAuditLog.create({
        data: {
          actorID: key.userID,
          action: 'console.key.read',
          entityType: 'api_key',
          entityID: key.id,
          requestId: diagnostic?.requestId,
          metadata: { scope: permission },
        },
      }),
    ]);
    return true;
  }
}
