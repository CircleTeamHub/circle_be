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

    let result: Awaited<ReturnType<typeof this.runUpgradeTransaction>>;
    try {
      result = await this.runUpgradeTransaction(
        userId,
        level,
        plan,
        idempotencyKey,
      );
    } catch (error) {
      // round 2 review：同键并发 —— 预检时首个请求还没提交，本请求进入事务
      // 后在 CAS 抢占处输掉（LevelNotHigher）。此时若同键的成交记录已经落库，
      // 语义上这是「重试」而不是「重复购买」，必须回放成功态而不是报错。
      if (
        idempotencyKey &&
        error instanceof BadRequestException &&
        this.errorCodeOf(error) === MembershipErrorCode.LevelNotHigher
      ) {
        const replay = await this.tryReplayIdempotentUpgrade(
          userId,
          level,
          plan,
          idempotencyKey,
        );
        if (replay) return replay;
      }
      throw error;
    }
    return this.finishUpgradeSideEffects(userId, level, plan, result);
  }

  /** 扣费+升级的可序列化事务体（从 upgrade 抽出，便于同键并发的回放复查）。 */
  private runUpgradeTransaction(
    userId: string,
    level: number,
    plan: MembershipPlanDto,
    idempotencyKey?: string,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
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
  }

  /** 幂等错误码提取（response 为对象时）。 */
  private errorCodeOf(error: BadRequestException): string | undefined {
    const response = error.getResponse();
    return typeof response === 'object' && response !== null
      ? (response as { errorCode?: string }).errorCode
      : undefined;
  }

  /**
   * 同键并发输家的回放复查（round 2 review）：CAS 输了之后同键成交记录已
   * 存在且归属/参数吻合 → 按重试回放当前状态；不吻合/不存在 → null 由调用方
   * 原样抛错。
   */
  private async tryReplayIdempotentUpgrade(
    userId: string,
    level: number,
    plan: MembershipPlanDto,
    idempotencyKey: string,
  ): Promise<UpgradeMembershipResponseDto | null> {
    const priorTx = await this.prisma.coinTransaction.findUnique({
      where: { idempotencyKey },
      select: { userID: true, type: true, amount: true, note: true },
    });
    const matches =
      priorTx &&
      priorTx.userID === userId &&
      priorTx.type === 'PURCHASE' &&
      priorTx.amount === -plan.price &&
      priorTx.note === `兑换 VIP${level}`;
    return matches ? this.currentStateResponse(userId, plan) : null;
  }

  /** 成交后的通知与广播（从 upgrade 抽出）。 */
  private async finishUpgradeSideEffects(
    userId: string,
    level: number,
    plan: MembershipPlanDto,
    result: UpgradeMembershipResponseDto,
  ): Promise<UpgradeMembershipResponseDto> {
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
