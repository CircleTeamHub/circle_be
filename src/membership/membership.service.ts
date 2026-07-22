import {
  BadRequestException,
  ConflictException,
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

  /** #91：幂等重试的回放响应 —— 返回当前会员与钱包状态（与首次响应同形）。 */
  private async currentStateResponse(
    userId: string,
    plan: (typeof VIP_PLANS)[number],
  ): Promise<UpgradeMembershipResponseDto> {
    const [user, wallet] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, vipLevel: true, creditScore: true },
      }),
      this.prisma.wallet.findUniqueOrThrow({ where: { userID: userId } }),
    ]);
    return { user, wallet, plan };
  }

  getPlans(): MembershipPlanDto[] {
    return VIP_PLANS;
  }

  async upgrade(
    userId: string,
    level: number,
    idempotencyKey?: string,
  ): Promise<UpgradeMembershipResponseDto> {
    const plan = VIP_PLANS.find((item) => item.level === level);
    if (!plan) {
      throw new BadRequestException({
        message: 'Invalid VIP level',
        errorCode: MembershipErrorCode.InvalidLevel,
      });
    }

    // #91：与 coin 转账同款幂等。同 key 的重试直接回放当前状态，不再进扣费
    // 事务（CAS 已挡住同级双扣，这里挡的是「响应丢失后的盲重试」语义漂移）。
    // review 修复：命中行必须核对归属与原始购买参数 —— 只查 key 存在的话，
    // 别人用过的 key / 自己上次买 VIP1 的 key 会让这次 VIP2 请求不扣费不升级
    // 却返回成功形状。参数不符按冲突拒绝，不给「假成功」。
    if (idempotencyKey) {
      const priorTx = await this.prisma.coinTransaction.findUnique({
        where: { idempotencyKey },
        select: {
          id: true,
          userID: true,
          type: true,
          amount: true,
          note: true,
        },
      });
      if (priorTx) {
        const matchesThisPurchase =
          priorTx.userID === userId &&
          priorTx.type === 'PURCHASE' &&
          priorTx.amount === -plan.price &&
          priorTx.note === `兑换 VIP${level}`;
        if (!matchesThisPurchase) {
          throw new ConflictException({
            message: 'Idempotency-Key was already used for a different request',
            errorCode: MembershipErrorCode.IdempotencyKeyReused,
          });
        }
        return this.currentStateResponse(userId, plan);
      }
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
          idempotencyKey: idempotencyKey ?? null,
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
