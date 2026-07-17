import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembershipErrorCode } from 'src/common/app-error-codes';
import { NotificationService } from 'src/notification/notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  MembershipPlanDto,
  UpgradeMembershipResponseDto,
} from './dto/membership.dto';

const VIP_PLANS: MembershipPlanDto[] = [
  { level: 1, name: 'VIP1', price: 780, perks: '基础会员权益' },
  { level: 2, name: 'VIP2', price: 1280, perks: '更多群容量与基础折扣' },
  { level: 3, name: 'VIP3', price: 2100, perks: '高级身份标识与积分加成' },
  { level: 4, name: 'VIP4', price: 4600, perks: '专属靓号折扣与优先体验' },
  { level: 5, name: 'VIP5', price: 9100, perks: '至尊会员权益与最高折扣' },
];

@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly notificationService: NotificationService,
  ) {}

  getPlans(): MembershipPlanDto[] {
    return VIP_PLANS;
  }

  async upgrade(
    userId: string,
    level: number,
  ): Promise<UpgradeMembershipResponseDto> {
    const plan = VIP_PLANS.find((item) => item.level === level);
    if (!plan) {
      throw new BadRequestException({
        message: 'Invalid VIP level',
        errorCode: MembershipErrorCode.InvalidLevel,
      });
    }

    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const currentUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, vipLevel: true },
      });
      if (!currentUser) {
        throw new NotFoundException({
          message: 'User not found',
          errorCode: MembershipErrorCode.UserNotFound,
        });
      }
      // Fast-fail on an obviously redundant upgrade. This read is only a
      // snapshot, so it cannot be the concurrency guard — the compare-and-swap
      // below is. Keeping it preserves the precise 404-vs-400 distinction that
      // the swap alone (count === 0 either way) could not express.
      if (level <= currentUser.vipLevel) {
        throw new BadRequestException({
          message: 'Target VIP level must be higher than current level',
          errorCode: MembershipErrorCode.LevelNotHigher,
        });
      }

      await tx.wallet.upsert({
        where: { userID: userId },
        update: {},
        create: { userID: userId },
      });

      // Claim the level BEFORE moving any money. `updateMany` re-evaluates
      // `vipLevel < level` against the latest committed row, so exactly one of
      // N concurrent upgrades to the same level can match. The loser bails out
      // here, having debited nothing; without this, two requests that both read
      // the pre-upgrade level would both fall through and charge the wallet.
      const claim = await tx.user.updateMany({
        where: { id: userId, vipLevel: { lt: level } },
        data: { vipLevel: level },
      });
      if (claim.count !== 1) {
        throw new BadRequestException({
          message: 'Target VIP level must be higher than current level',
          errorCode: MembershipErrorCode.LevelNotHigher,
        });
      }

      const debitResult = await tx.wallet.updateMany({
        where: { userID: userId, balance: { gte: plan.price } },
        data: { balance: { decrement: plan.price } },
      });
      if (debitResult.count !== 1) {
        throw new BadRequestException({
          message: 'Insufficient points',
          errorCode: MembershipErrorCode.InsufficientPoints,
        });
      }

      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userID: userId },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, vipLevel: true, creditScore: true },
      });

      await tx.coinTransaction.create({
        data: {
          userID: userId,
          type: 'PURCHASE',
          amount: -plan.price,
          balance: wallet.balance,
          note: `兑换 VIP${level}`,
        },
      });

      return { user, wallet, plan };
    });

    let notification = null;
    try {
      notification = await this.notificationService.createSystemNotification(
        userId,
        userId,
        `已成功兑换 VIP${level}`,
      );
    } catch {
      // Notification failure should not affect the successful purchase
    }

    await this.realtimeService.invalidateUserHotCache(userId);
    await this.realtimeService.safeBroadcastAll([
      () => this.realtimeService.broadcastMembershipStatus(userId),
      () =>
        this.realtimeService.broadcastWalletBalanceChanged(userId, {
          reason: 'PURCHASE',
          delta: -plan.price,
        }),
      () =>
        this.realtimeService.broadcastSystemNotificationCreated(
          userId,
          `已成功兑换 VIP${level}`,
        ),
      ...(notification
        ? [
            () =>
              this.realtimeService.broadcastNotificationCreated(
                userId,
                notification,
              ),
          ]
        : []),
      () => this.realtimeService.broadcastSystemNotificationUnread(userId),
      () => this.realtimeService.broadcastUserProfileSummary(userId),
    ]);

    return result;
  }
}
