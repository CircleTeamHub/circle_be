import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MembershipBenefitType, Prisma } from 'src/generated/prisma';
import { MembershipErrorCode } from 'src/common/app-error-codes';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import {
  CreateMembershipGrantDto,
  MembershipAdminGrantResponseDto,
} from './dto/membership.dto';
import { MembershipPolicyService } from './membership-policy.service';
import {
  MEMBERSHIP_CATALOG,
  MembershipLevel,
  addUtcCalendarMonths,
} from './membership.catalog';
import { mapMembershipStatus } from './membership.service';

const GRANT_REPLAY_INCLUDE = {
  benefitGrants: { select: { type: true } },
} as const satisfies Prisma.MembershipGrantInclude;

type ReplayableGrant = Prisma.MembershipGrantGetPayload<{
  include: typeof GRANT_REPLAY_INCLUDE;
}>;

type CanonicalGrantInput = {
  targetLevel: MembershipLevel;
  idempotencyKey: string;
  note: string | null;
};

@Injectable()
export class MembershipAdminService {
  private readonly logger = new Logger(MembershipAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly membershipPolicy: MembershipPolicyService,
    private readonly notificationService: NotificationService,
    private readonly realtimeService: RealtimeService,
  ) {}

  async grant(
    operatorUserId: string,
    targetUserId: string,
    dto: CreateMembershipGrantDto,
  ): Promise<MembershipAdminGrantResponseDto> {
    const input = this.canonicalizeInput(dto);
    let transactionResult: {
      created: boolean;
      response: MembershipAdminGrantResponseDto;
    };

    try {
      transactionResult = await runSerializableTransaction(
        this.prisma,
        async (tx) => {
          await this.membershipPolicy.lockUsers(tx, [targetUserId]);

          const replay = await tx.membershipGrant.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            include: GRANT_REPLAY_INCLUDE,
          });
          if (replay) {
            return {
              created: false,
              response: this.replayOrThrow(
                replay,
                operatorUserId,
                targetUserId,
                input,
              ),
            };
          }

          const target = await tx.user.findUnique({
            where: { id: targetUserId },
            select: {
              id: true,
              vipLevel: true,
              vipExpiresAt: true,
              membershipBenefitGrants: { select: { type: true } },
            },
          });
          if (!target) {
            throw new NotFoundException({
              message: 'User not found',
              errorCode: MembershipErrorCode.UserNotFound,
            });
          }

          const transactionNow = new Date();
          const previous = this.membershipPolicy.resolve(
            target,
            transactionNow,
          );
          if (input.targetLevel <= previous.level) {
            throw new ConflictException({
              message: 'Target membership level must be higher',
              errorCode: MembershipErrorCode.LevelNotHigher,
            });
          }

          const targetTier = MEMBERSHIP_CATALOG[input.targetLevel];
          const newExpiresAt = targetTier.lifetime
            ? null
            : addUtcCalendarMonths(
                this.expiryBase(target, previous.level, transactionNow),
                targetTier.durationMonths,
              );
          const benefitType = this.benefitForTarget(input.targetLevel);
          const previouslyIssued = target.membershipBenefitGrants.map(
            (benefit) => benefit.type,
          );
          const issuedBenefitTypes =
            benefitType && !previouslyIssued.includes(benefitType)
              ? [benefitType]
              : [];
          const benefitTypesSnapshot = [
            ...new Set([...previouslyIssued, ...issuedBenefitTypes]),
          ];

          const grant = await tx.membershipGrant.create({
            data: {
              idempotencyKey: input.idempotencyKey,
              targetUserID: targetUserId,
              operatorUserID: operatorUserId,
              previousLevel: target.vipLevel,
              previousEffectiveLevel: previous.level,
              newLevel: input.targetLevel,
              previousExpiresAt: target.vipExpiresAt,
              newExpiresAt,
              benefitTypesSnapshot,
              note: input.note,
            },
          });

          await tx.user.update({
            where: { id: targetUserId },
            data: {
              vipLevel: input.targetLevel,
              vipExpiresAt: newExpiresAt,
            },
          });

          if (benefitType && issuedBenefitTypes.includes(benefitType)) {
            await tx.membershipBenefitGrant.create({
              data: {
                userID: targetUserId,
                membershipGrantID: grant.id,
                type: benefitType,
              },
            });
          }

          const replayableGrant: ReplayableGrant = {
            ...grant,
            benefitGrants: issuedBenefitTypes.map((type) => ({ type })),
          };
          return {
            created: true,
            response: this.toResponse(replayableGrant, false),
          };
        },
      );
    } catch (error) {
      if (prismaErrorCode(error) !== 'P2002') {
        throw error;
      }

      const replay = await this.prisma.membershipGrant.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: GRANT_REPLAY_INCLUDE,
      });
      if (!replay) {
        throw error;
      }
      transactionResult = {
        created: false,
        response: this.replayOrThrow(
          replay,
          operatorUserId,
          targetUserId,
          input,
        ),
      };
    }

    if (transactionResult.created) {
      await this.runPostCommitSideEffects(targetUserId);
    }
    return transactionResult.response;
  }

  private canonicalizeInput(
    dto: CreateMembershipGrantDto,
  ): CanonicalGrantInput {
    if (
      !Number.isInteger(dto.targetLevel) ||
      dto.targetLevel < 1 ||
      dto.targetLevel > 4
    ) {
      throw new BadRequestException({
        message: 'Invalid membership level',
        errorCode: MembershipErrorCode.InvalidLevel,
      });
    }
    return {
      targetLevel: dto.targetLevel as MembershipLevel,
      idempotencyKey: dto.idempotencyKey,
      note: dto.note?.trim() || null,
    };
  }

  private expiryBase(
    target: { vipExpiresAt: Date | null },
    previousEffectiveLevel: MembershipLevel,
    now: Date,
  ): Date {
    if (
      previousEffectiveLevel > 0 &&
      previousEffectiveLevel < 4 &&
      target.vipExpiresAt &&
      target.vipExpiresAt.getTime() > now.getTime()
    ) {
      return target.vipExpiresAt;
    }
    return now;
  }

  private benefitForTarget(
    targetLevel: MembershipLevel,
  ): MembershipBenefitType | null {
    if (targetLevel === 3) {
      return MembershipBenefitType.STANDARD_FANCY_NUMBER;
    }
    if (targetLevel === 4) {
      return MembershipBenefitType.PREMIUM_FANCY_NUMBER;
    }
    return null;
  }

  private replayOrThrow(
    grant: ReplayableGrant,
    operatorUserId: string,
    targetUserId: string,
    input: CanonicalGrantInput,
  ): MembershipAdminGrantResponseDto {
    if (
      grant.operatorUserID !== operatorUserId ||
      grant.targetUserID !== targetUserId ||
      grant.newLevel !== input.targetLevel ||
      grant.note !== input.note
    ) {
      throw new ConflictException({
        message: 'Idempotency key was already used for a different grant',
        errorCode: MembershipErrorCode.IdempotencyConflict,
      });
    }

    return this.toResponse(grant, true);
  }

  private toResponse(
    grant: ReplayableGrant,
    replayed: boolean,
  ): MembershipAdminGrantResponseDto {
    const newLevel = grant.newLevel as MembershipLevel;
    const tier = MEMBERSHIP_CATALOG[newLevel];
    const issuedBenefitTypes = grant.benefitGrants.map(
      (benefit) => benefit.type,
    );

    return {
      replayed,
      grant: {
        id: grant.id,
        idempotencyKey: grant.idempotencyKey,
        targetUserId: grant.targetUserID,
        operatorUserId: grant.operatorUserID,
        previousLevel: grant.previousLevel,
        previousEffectiveLevel: grant.previousEffectiveLevel as MembershipLevel,
        newLevel: grant.newLevel,
        previousExpiresAt: grant.previousExpiresAt,
        newExpiresAt: grant.newExpiresAt,
        note: grant.note,
        createdAt: grant.createdAt,
      },
      membership: mapMembershipStatus(
        { vipLevel: newLevel, vipExpiresAt: grant.newExpiresAt },
        tier,
        newLevel,
        grant.benefitTypesSnapshot,
      ),
      issuedBenefitTypes,
    };
  }

  private async runPostCommitSideEffects(targetUserId: string): Promise<void> {
    const content = '会员权益已更新';
    const [cacheResult, notificationResult] = await Promise.allSettled([
      this.realtimeService.invalidateUserHotCache(targetUserId),
      this.notificationService.createSystemNotification(
        targetUserId,
        targetUserId,
        content,
      ),
    ]);
    // deleteKey 软失败（Redis 不可用时返回 false 而不抛）同样算失效失败：allSettled 会把它
    // 当 fulfilled，若不复检返回值，下面的 broadcastMembershipStatus / ProfileSummary 会把
    // pre-grant 的陈旧缓存推给客户端。强制再失效一次收窄陈旧窗口。
    const cacheInvalidated =
      cacheResult.status === 'fulfilled' && cacheResult.value === true;
    if (!cacheInvalidated) {
      this.logger.warn(
        'Membership cache invalidation failed after commit; retrying before broadcast',
      );
      await this.realtimeService
        .invalidateUserHotCache(targetUserId)
        .catch(() => undefined);
    }
    if (notificationResult.status === 'rejected') {
      this.logger.warn('Membership notification failed after commit');
    }

    const notification =
      notificationResult.status === 'fulfilled'
        ? notificationResult.value
        : null;
    try {
      await this.realtimeService.safeBroadcastAll([
        () => this.realtimeService.broadcastMembershipStatus(targetUserId),
        () => this.realtimeService.broadcastUserProfileSummary(targetUserId),
        ...(notification
          ? [
              () =>
                this.realtimeService.broadcastSystemNotificationCreated(
                  targetUserId,
                  content,
                ),
              () =>
                this.realtimeService.broadcastNotificationCreated(
                  targetUserId,
                  notification,
                ),
              () =>
                this.realtimeService.broadcastSystemNotificationUnread(
                  targetUserId,
                ),
            ]
          : []),
      ]);
    } catch {
      this.logger.warn('Membership realtime broadcasts failed after commit');
    }
  }
}
