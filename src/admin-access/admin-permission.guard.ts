import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from 'src/prisma/prisma.service';

export const ADMIN_PERMISSION_KEY = 'admin:permission';
export type AdminPermission =
  | 'DASHBOARD'
  | 'USER_READ'
  | 'USER_MODERATE'
  | 'USER_SENSITIVE'
  | 'COMMUNITY_MANAGE'
  | 'IM_READ'
  | 'IM_MODERATE'
  | 'SUPPORT_MANAGE'
  | 'COMMERCE_MANAGE'
  | 'RECHARGE_MANAGE'
  | 'MODERATION_MANAGE'
  | 'CONTENT_MANAGE'
  | 'AUDIT_READ'
  | 'ACCESS_MANAGE';
export const RequireAdminPermission = (permission: AdminPermission) =>
  SetMetadata(ADMIN_PERMISSION_KEY, permission);

export const ADMIN_ROLE_PERMISSIONS: Record<
  string,
  readonly AdminPermission[]
> = {
  SUPER_ADMIN: [
    'DASHBOARD',
    'USER_READ',
    'USER_MODERATE',
    'USER_SENSITIVE',
    'COMMUNITY_MANAGE',
    'IM_READ',
    'IM_MODERATE',
    'SUPPORT_MANAGE',
    'COMMERCE_MANAGE',
    'RECHARGE_MANAGE',
    'MODERATION_MANAGE',
    'CONTENT_MANAGE',
    'AUDIT_READ',
    'ACCESS_MANAGE',
  ],
  OPERATIONS: [
    'DASHBOARD',
    'USER_READ',
    'COMMUNITY_MANAGE',
    'COMMERCE_MANAGE',
    'CONTENT_MANAGE',
  ],
  MODERATOR: [
    'DASHBOARD',
    'USER_READ',
    'USER_MODERATE',
    'COMMUNITY_MANAGE',
    'IM_READ',
    'IM_MODERATE',
    'MODERATION_MANAGE',
    'AUDIT_READ',
  ],
  SUPPORT: ['USER_READ', 'IM_READ', 'SUPPORT_MANAGE', 'RECHARGE_MANAGE'],
};

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (req.user?.role !== 'ADMIN' || req.user?.audience !== 'ADMIN')
      return false;
    const permission = this.reflector.getAllAndOverride<AdminPermission>(
      ADMIN_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        role: true,
        status: true,
        adminAccess: { select: { role: true } },
      },
    });
    if (user?.role !== 'ADMIN' || user.status !== 'ACTIVE' || !user.adminAccess)
      return false;
    return (ADMIN_ROLE_PERMISSIONS[user.adminAccess.role] ?? []).includes(
      permission,
    );
  }
}
