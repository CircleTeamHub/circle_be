import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedUser } from 'src/auth/types';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import { AdminUserErrorCode } from 'src/common/app-error-codes';
import { Prisma, UserStatus } from 'src/generated/prisma';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { createLoggingConfig } from 'src/logging/logging.config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { AdminUserAuditService } from './admin-user-audit.service';
import {
  AdminAuditAction,
  SENSITIVE_FIELDS,
  SensitiveField,
} from './admin-user.constants';
import { maskSensitiveField } from './admin-user.masking';
import {
  ListAdminUsersQueryDto,
  AdminUpdateUserStatusDto,
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
  private readonly logger = new Logger(AdminUserService.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminUserAuditService,
    private readonly sessionRevocation: SessionRevocationService,
    private readonly realtime: RealtimeService,
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

  async updateStatus(
    actor: Pick<AuthenticatedUser, 'userId' | 'accountId'>,
    targetId: string,
    dto: AdminUpdateUserStatusDto,
  ) {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 3 || reason.length > 500) {
      throw new BadRequestException('操作原因必须为 3 到 500 个字符');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: targetId },
        select: { id: true, accountId: true, status: true },
      });
      if (!current) {
        throw this.userNotFound();
      }

      if (
        actor.userId === targetId &&
        (dto.status === UserStatus.BANNED || dto.status === UserStatus.DELETED)
      ) {
        // 这是权限自保护，不是参数问题；错误目录也把它定为 403。
        throw new ForbiddenException({
          message: '不能封禁或删除当前管理员账号',
          errorCode: AdminUserErrorCode.SelfStatusChange,
        });
      }

      const allowed =
        (current.status === UserStatus.ACTIVE &&
          (dto.status === UserStatus.BANNED ||
            dto.status === UserStatus.DELETED)) ||
        (current.status === UserStatus.BANNED &&
          (dto.status === UserStatus.ACTIVE ||
            dto.status === UserStatus.DELETED));
      if (!allowed) {
        throw new ConflictException({
          message: '不允许执行该账号状态变更',
          errorCode: AdminUserErrorCode.InvalidStatusTransition,
        });
      }

      if (
        dto.status === UserStatus.DELETED &&
        dto.confirmationAccountId !== current.accountId
      ) {
        throw new BadRequestException({
          message: '删除确认账号 ID 不匹配',
          errorCode: AdminUserErrorCode.ConfirmationMismatch,
        });
      }

      const changed = await tx.user.updateMany({
        where: { id: targetId, status: current.status },
        data: { status: dto.status },
      });
      if (changed.count !== 1) {
        throw new ConflictException({
          message: '账号状态已被其他操作修改，请刷新后重试',
          errorCode: AdminUserErrorCode.StatusConflict,
        });
      }

      const revokedAt =
        dto.status !== UserStatus.ACTIVE ? new Date() : undefined;
      if (revokedAt) {
        const expiresAt = this.sessionRevocation.revocationExpiresAt(
          revokedAt.getTime(),
        );
        await tx.refreshToken.updateMany({
          where: { userId: targetId, revokedAt: null },
          data: { revokedAt },
        });
        await tx.sessionRevocationOutbox.upsert({
          where: { userID: targetId },
          create: { userID: targetId, revokedAt, expiresAt },
          update: {
            revokedAt,
            expiresAt,
            attempts: 0,
            lastError: null,
            nextAttemptAt: revokedAt,
          },
        });
      }

      const action =
        dto.status === UserStatus.BANNED
          ? AdminAuditAction.UserBanned
          : dto.status === UserStatus.DELETED
            ? AdminAuditAction.UserDeleted
            : AdminAuditAction.UserUnbanned;
      await this.audit.recordInTransaction(tx, {
        actorId: actor.userId,
        actorAccountId: actor.accountId,
        action,
        targetType: 'user',
        targetId,
        before: { status: current.status },
        after: { status: dto.status },
        reason,
      });

      return {
        id: current.id,
        accountId: current.accountId,
        status: dto.status,
        previousStatus: current.status,
        revokedAt,
      };
    });

    const sessionRevocationPending = result.revokedAt
      ? !(await this.completeSessionRevocation(targetId, result.revokedAt))
      : false;
    await this.runPostCommitHook('invalidate profile summary cache', () =>
      this.realtime.invalidateUserProfileSummaryCache(targetId),
    );
    await this.runPostCommitHook('broadcast profile summary', () =>
      this.realtime.broadcastUserProfileSummary(targetId),
    );

    // 审计表之外还要留一条业务事件：封禁/解封/删除本来就统计在
    // business_events_total 与结构化日志里，管理台迁到这个接口后不能断流。
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'admin_user_status_changed',
      actorId: actor.userId,
      targetId,
      result: 'success',
      entityType: 'user',
      entityId: targetId,
      metadata: {
        oldStatus: result.previousStatus,
        newStatus: dto.status,
        reason,
        sessionRevocationPending,
      },
    });

    return {
      id: result.id,
      accountId: result.accountId,
      status: result.status,
      sessionRevocationPending,
    };
  }

  private async completeSessionRevocation(
    userId: string,
    revokedAt: Date,
  ): Promise<boolean> {
    try {
      const completed = await this.sessionRevocation.revokeUserAt(
        userId,
        revokedAt.getTime(),
      );
      if (!completed) {
        this.logger.warn('Admin user session revocation remains pending');
        return false;
      }
    } catch (error) {
      this.logger.warn(
        `Admin user status committed but failed to revoke user sessions: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    await this.runPostCommitHook(
      'remove completed session revocation outbox',
      () =>
        this.prisma.sessionRevocationOutbox.deleteMany({
          where: { userID: userId, revokedAt },
        }),
    );
    return true;
  }

  private async runPostCommitHook(
    name: string,
    hook: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await hook();
    } catch (error) {
      this.logger.warn(
        `Admin user status committed but failed to ${name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private userNotFound() {
    return new NotFoundException({
      message: '用户不存在',
      errorCode: AdminUserErrorCode.NotFound,
    });
  }
}
