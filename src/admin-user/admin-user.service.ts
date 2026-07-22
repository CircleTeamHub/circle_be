import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedUser } from 'src/auth/types';
import { AdminUserErrorCode } from 'src/common/app-error-codes';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';
import {
  AdminAuditAction,
  SENSITIVE_FIELDS,
  SensitiveField,
} from './admin-user.constants';
import { maskSensitiveField } from './admin-user.masking';
import {
  ListAdminUsersQueryDto,
  RevealSensitiveFieldDto,
} from './dto/admin-user.dto';

const ADMIN_USER_LIST_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  email: true,
  phoneNumber: true,
  role: true,
  status: true,
  createdAt: true,
  lastOnline: true,
} as const;

const ADMIN_USER_DETAIL_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  role: true,
  status: true,
  city: true,
  region: true,
  gender: true,
  createdAt: true,
  updatedAt: true,
  lastOnline: true,
  email: true,
  phoneNumber: true,
  wechat: true,
  qq: true,
  whatsup: true,
  securityCodeLockedUntil: true,
  singleDeviceLoginEnabled: true,
  openimSynced: true,
  creditScore: true,
} as const;

@Injectable()
export class AdminUserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async listUsers(query: ListAdminUsersQueryDto) {
    const { page = 1, limit = 20 } = query;
    const keyword = query.keyword?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom
                ? { gte: new Date(query.createdFrom) }
                : {}),
              ...(query.createdTo ? { lte: new Date(query.createdTo) } : {}),
            },
          }
        : {}),
      ...(keyword
        ? {
            OR: [
              { accountId: { contains: keyword, mode: 'insensitive' } },
              { nickname: { contains: keyword, mode: 'insensitive' } },
              { email: { contains: keyword, mode: 'insensitive' } },
              { phoneNumber: { contains: keyword } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: ADMIN_USER_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: users.map(({ email, phoneNumber, ...user }) => ({
        ...user,
        maskedEmail: maskSensitiveField('email', email),
        maskedPhoneNumber: maskSensitiveField('phoneNumber', phoneNumber),
      })),
      total,
      page,
      limit,
    };
  }

  async getUserDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: ADMIN_USER_DETAIL_SELECT,
    });

    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AdminUserErrorCode.NotFound,
      });
    }

    const now = new Date();
    const [
      activeSessionCount,
      activePushDeviceCount,
      friendCount,
      noteCount,
      traceCount,
      circlesOwnedCount,
      circleMembershipCount,
      reportsFiledCount,
      reportsReceivedCount,
      wallet,
    ] = await Promise.all([
      this.prisma.refreshToken.count({
        where: { userId: id, revokedAt: null, expiredAt: { gt: now } },
      }),
      this.prisma.devicePushToken.count({
        where: { userID: id, disabledAt: null },
      }),
      this.prisma.friend.count({
        where: {
          state: 'ACCEPTED',
          OR: [{ userID: id }, { friendID: id }],
        },
      }),
      this.prisma.note.count({
        where: { ownerID: id, status: 'ACTIVE' },
      }),
      this.prisma.trace.count({
        where: { fromID: id, deleted: false },
      }),
      this.prisma.circle.count({
        where: { ownerID: id, deleted: false },
      }),
      this.prisma.circleMember.count({
        where: { userID: id, status: 'ACTIVE' },
      }),
      this.prisma.friendReport.count({ where: { reporterID: id } }),
      this.prisma.friendReport.count({ where: { targetID: id } }),
      this.prisma.wallet.findUnique({
        where: { userID: id },
        select: { balance: true },
      }),
    ]);

    return {
      profile: {
        id: user.id,
        accountId: user.accountId,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: user.role,
        status: user.status,
        city: user.city,
        region: user.region,
        gender: user.gender,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastOnline: user.lastOnline,
      },
      maskedContacts: {
        email: maskSensitiveField('email', user.email),
        phoneNumber: maskSensitiveField('phoneNumber', user.phoneNumber),
        wechat: maskSensitiveField('wechat', user.wechat),
        qq: maskSensitiveField('qq', user.qq),
        whatsup: maskSensitiveField('whatsup', user.whatsup),
      },
      security: {
        securityCodeLocked: Boolean(
          user.securityCodeLockedUntil &&
            user.securityCodeLockedUntil.getTime() > now.getTime(),
        ),
        singleDeviceLoginEnabled: user.singleDeviceLoginEnabled,
        activeSessionCount,
        activePushDeviceCount,
        openimSynced: user.openimSynced,
      },
      summary: {
        creditScore: user.creditScore,
        walletBalance: wallet?.balance ?? 0,
        friendCount,
        noteCount,
        traceCount,
        circlesOwnedCount,
        circleMembershipCount,
        reportsFiledCount,
        reportsReceivedCount,
      },
    };
  }

  async revealSensitiveField(
    actor: Pick<AuthenticatedUser, 'userId' | 'accountId'>,
    targetId: string,
    dto: RevealSensitiveFieldDto,
  ) {
    if (!SENSITIVE_FIELDS.includes(dto.field as SensitiveField)) {
      throw new BadRequestException({
        message: '不支持查看该敏感字段',
        errorCode: AdminUserErrorCode.SensitiveFieldInvalid,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, [dto.field]: true },
    });
    if (!user) {
      throw this.userNotFound();
    }

    try {
      await this.audit.recordInTransaction(this.prisma, {
        actorId: actor.userId,
        actorAccountId: actor.accountId,
        action: AdminAuditAction.SensitiveFieldViewed,
        targetType: 'user',
        targetId,
        reason: dto.reason,
        metadata: { field: dto.field },
      });
    } catch {
      throw new ServiceUnavailableException({
        message: '审计记录暂时不可用，敏感信息未返回',
        errorCode: AdminUserErrorCode.AuditUnavailable,
      });
    }

    const revealedAt = new Date();
    const selectedContact = user as unknown as Record<
      SensitiveField,
      string | null
    >;
    return {
      field: dto.field,
      value: selectedContact[dto.field],
      revealedAt,
      expiresAt: new Date(revealedAt.getTime() + 60_000),
    };
  }

  async listAuditLogs(targetId: string, limit = 20) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true },
    });
    if (!user) {
      throw this.userNotFound();
    }

    return this.audit.listForTarget('user', targetId, limit);
  }

  private userNotFound() {
    return new NotFoundException({
      message: '用户不存在',
      errorCode: AdminUserErrorCode.NotFound,
    });
  }
}
