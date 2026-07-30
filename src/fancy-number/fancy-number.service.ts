import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import {
  addUtcCalendarMonths,
  resolveEffectiveMembershipLevel,
} from 'src/membership/membership.catalog';
import { ACCOUNT_ID_PATTERN } from 'src/utils/account-id';
import { FancyNumberErrorCode } from 'src/common/app-error-codes';
import { Prisma } from 'src/generated/prisma';
import {
  CUSTOM_FANCY_NUMBER_PATTERN,
  normalizeCustomFancyNumber,
  validateCustomFancyNumber,
} from './fancy-number.rules';
import { lockFancyNumberUser } from './fancy-number-user-lock';

const FANCY_NUMBER_UNIT_PRICE = 100;
const FANCY_NUMBER_RECOMMENDATION_LIMIT = 100;
const FANCY_NUMBER_RECOMMENDATION_LOCK = 'fancy-number-recommendations';
const FANCY_NUMBER_RECOMMENDATION_SELECT = {
  id: true,
  value: true,
  status: true,
  source: true,
  isRecommended: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FancyNumberSelect;
type FancyNumberRecommendationRow = Prisma.FancyNumberGetPayload<{
  select: typeof FANCY_NUMBER_RECOMMENDATION_SELECT;
}>;

export type FancyNumberPurchaseResult = {
  orderId: string;
  accountId: string;
  expiresAt: Date | null;
  permanent: boolean;
  months: number | null;
  unitPrice: number;
  totalPrice: number;
  walletBalanceAfter: number;
};

type FancyNumberTarget =
  | { kind: 'inventory'; id: string }
  | { kind: 'custom'; value: string };

@Injectable()
export class FancyNumberService {
  private readonly logger = new Logger(FancyNumberService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async listAvailable(
    userId: string,
    query: { cursor?: string; limit?: number },
    now = new Date(),
  ): Promise<{
    items: Array<{ id: string; value: string }>;
    nextCursor: string | null;
    unitPrice: number;
    minMonths: number;
    maxMonths: number;
    purchaseMode: 'PAID_MONTHLY' | 'PERMANENT_FREE';
  }> {
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException('limit must be an integer from 1 to 50');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true, vipExpiresAt: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const rows = await this.prisma.fancyNumber.findMany({
      where: { status: 'AVAILABLE', isRecommended: true },
      select: { id: true, value: true, source: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(({ id, value, source }) => ({
      id,
      value: source === 'CUSTOM' ? value.toUpperCase() : value,
    }));
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      unitPrice: FANCY_NUMBER_UNIT_PRICE,
      minMonths: 1,
      maxMonths: 12,
      purchaseMode:
        resolveEffectiveMembershipLevel(user, now) === 4
          ? 'PERMANENT_FREE'
          : 'PAID_MONTHLY',
    };
  }

  async checkCustomAvailability(
    _userId: string,
    value: string,
  ): Promise<{
    value: string;
    available: boolean;
    reason: 'TAKEN' | 'RESERVED' | null;
  }> {
    const normalized = normalizeCustomFancyNumber(value);
    if (!CUSTOM_FANCY_NUMBER_PATTERN.test(normalized.displayValue)) {
      throw new BadRequestException({
        message: '靓号必须是 6 位英文字母或数字',
        errorCode: FancyNumberErrorCode.InvalidValue,
      });
    }
    try {
      validateCustomFancyNumber(normalized.displayValue);
    } catch {
      return {
        value: normalized.displayValue,
        available: false,
        reason: 'RESERVED',
      };
    }

    const identifier = await this.prisma.accountIdentifier.findUnique({
      where: { value: normalized.storedValue },
      select: {
        currentUserID: true,
        reservedForUserID: true,
        inviteOwnerUserID: true,
        fancyNumber: { select: { status: true } },
      },
    });
    const available =
      identifier === null || identifier.fancyNumber?.status === 'AVAILABLE';
    return {
      value: normalized.displayValue,
      available,
      reason: available ? null : 'TAKEN',
    };
  }

  async getMine(
    userId: string,
    now = new Date(),
  ): Promise<{
    active: boolean;
    accountId: string | null;
    restoreAccountId: string | null;
    startedAt: Date | null;
    expiresAt: Date | null;
    permanent: boolean;
    renewable: boolean;
    unitPrice: number;
  }> {
    const lease = await this.prisma.fancyNumberLease.findFirst({
      where: { userID: userId, endedAt: null },
      include: { fancyNumber: { select: { value: true, source: true } } },
    });
    if (!lease) {
      return this.inactiveFancyNumber();
    }
    if (
      lease.permanentAt === null &&
      lease.expiresAt !== null &&
      lease.expiresAt.getTime() <= now.getTime()
    ) {
      await this.expireLease(lease.id, now);
      return this.inactiveFancyNumber();
    }
    const permanent = lease.permanentAt !== null;
    return {
      active: true,
      accountId:
        lease.fancyNumber.source === 'CUSTOM'
          ? lease.fancyNumber.value.toUpperCase()
          : lease.fancyNumber.value,
      restoreAccountId: lease.restoreAccountId,
      startedAt: lease.startedAt,
      expiresAt: lease.expiresAt,
      permanent,
      renewable: !permanent,
      unitPrice: FANCY_NUMBER_UNIT_PRICE,
    };
  }

  async ensureAccountIdChangeAllowed(
    userId: string,
    now = new Date(),
  ): Promise<void> {
    const lease = await this.prisma.fancyNumberLease.findFirst({
      where: { userID: userId, endedAt: null },
      select: { id: true, expiresAt: true, permanentAt: true },
    });
    if (!lease) {
      return;
    }
    if (
      lease.permanentAt === null &&
      lease.expiresAt !== null &&
      lease.expiresAt.getTime() <= now.getTime()
    ) {
      await this.expireLease(lease.id, now);
      return;
    }
    throw new ConflictException({
      message: '使用靓号期间不能修改账号 ID',
      errorCode: FancyNumberErrorCode.AccountIdLocked,
    });
  }

  async convertActiveLeaseToPermanent(
    tx: Prisma.TransactionClient,
    userId: string,
    now = new Date(),
  ): Promise<boolean> {
    const lease = await tx.fancyNumberLease.findFirst({
      where: { userID: userId, endedAt: null },
      select: {
        id: true,
        userID: true,
        fancyNumberID: true,
        restoreAccountId: true,
        expiresAt: true,
        permanentAt: true,
        user: { select: { accountId: true } },
        fancyNumber: { select: { value: true } },
      },
    });
    if (!lease || lease.permanentAt !== null || lease.expiresAt === null) {
      return false;
    }
    if (lease.expiresAt.getTime() <= now.getTime()) {
      await this.restoreExpiredLeaseInTransaction(tx, lease, now);
      return false;
    }

    const converted = await tx.fancyNumberLease.updateMany({
      where: {
        id: lease.id,
        endedAt: null,
        permanentAt: null,
        expiresAt: { gt: now },
      },
      data: { expiresAt: null, permanentAt: now },
    });
    if (converted.count !== 1) {
      throw new ConflictException({
        message: '靓号租期状态已变化，请重试',
        errorCode: FancyNumberErrorCode.LeaseExpired,
      });
    }
    await tx.fancyNumber.update({
      where: { id: lease.fancyNumberID },
      data: { status: 'PERMANENT', disabledAt: null },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        fancyNumber: true,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: true,
      },
    });
    const conversionKey = `super-conversion:${lease.id}`;
    await tx.fancyNumberOrder.upsert({
      where: { idempotencyKey: conversionKey },
      update: {},
      create: {
        idempotencyKey: conversionKey,
        requestFingerprint: conversionKey,
        type: 'SUPER_CONVERSION',
        userID: userId,
        fancyNumberID: lease.fancyNumberID,
        leaseID: lease.id,
        months: null,
        unitPrice: 0,
        totalPrice: 0,
        walletBalanceAfter: null,
        previousExpiresAt: lease.expiresAt,
        newExpiresAt: null,
      },
    });
    return true;
  }

  async purchase(
    userId: string,
    fancyNumberId: string,
    months: number | undefined,
    idempotencyKey: string,
    now = new Date(),
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    return this.purchaseTarget(
      userId,
      { kind: 'inventory', id: fancyNumberId },
      months,
      idempotencyKey,
      now,
      expectedUnitPrice,
    );
  }

  async purchaseCustom(
    userId: string,
    value: string,
    months: number | undefined,
    idempotencyKey: string,
    now = new Date(),
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    const normalized = this.requireCustomFancyNumber(value);
    return this.purchaseTarget(
      userId,
      { kind: 'custom', value: normalized.storedValue },
      months,
      idempotencyKey,
      now,
      expectedUnitPrice,
    );
  }

  private async purchaseTarget(
    userId: string,
    target: FancyNumberTarget,
    months: number | undefined,
    idempotencyKey: string,
    now: Date,
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    const scopedIdempotencyKey = this.clientIdempotencyKey(
      userId,
      idempotencyKey,
    );
    await this.expireOverdueLeaseForUser(userId, now);

    const replay = await runSerializableTransaction(this.prisma, async (tx) => {
      await lockFancyNumberUser(tx, userId);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          status: true,
          accountId: true,
          vipLevel: true,
          vipExpiresAt: true,
        },
      });
      if (!user || user.status !== 'ACTIVE') {
        throw new NotFoundException('User not found');
      }
      const buildRequestFingerprint = (fingerprintMonths: number | null) =>
        JSON.stringify({
          operation: target.kind === 'custom' ? 'custom-purchase' : 'purchase',
          userId,
          ...(target.kind === 'custom'
            ? { value: target.value }
            : { fancyNumberId: target.id }),
          months: fingerprintMonths,
        });

      const existingOrder = await tx.fancyNumberOrder.findUnique({
        where: { idempotencyKey: scopedIdempotencyKey },
      });
      if (existingOrder) {
        const replayFingerprint = buildRequestFingerprint(
          existingOrder.newExpiresAt === null ? null : (months ?? null),
        );
        if (existingOrder.requestFingerprint !== replayFingerprint) {
          throw new ConflictException({
            message: '幂等键已用于其他请求',
            errorCode: FancyNumberErrorCode.IdempotencyConflict,
          });
        }
        return {
          replayed: true,
          result: {
            orderId: existingOrder.id,
            accountId: this.displayTargetValue(
              (
                await tx.fancyNumber.findUniqueOrThrow({
                  where: { id: existingOrder.fancyNumberID },
                  select: { value: true },
                })
              ).value,
              target,
            ),
            expiresAt: existingOrder.newExpiresAt,
            permanent: existingOrder.newExpiresAt === null,
            months: existingOrder.months,
            unitPrice: existingOrder.unitPrice,
            totalPrice: existingOrder.totalPrice,
            walletBalanceAfter: existingOrder.walletBalanceAfter ?? 0,
          },
        };
      }
      const permanent = resolveEffectiveMembershipLevel(user, now) === 4;
      if (
        !permanent &&
        (!Number.isInteger(months) || (months ?? 0) < 1 || (months ?? 0) > 12)
      ) {
        throw new BadRequestException({
          message: '购买月数必须是 1 到 12 的整数',
          errorCode: FancyNumberErrorCode.InvalidMonths,
        });
      }
      const normalizedMonths = permanent ? null : (months as number);
      const requestFingerprint = buildRequestFingerprint(normalizedMonths);
      if (
        expectedUnitPrice !== undefined &&
        expectedUnitPrice !== FANCY_NUMBER_UNIT_PRICE
      ) {
        throw new ConflictException({
          message: '靓号价格已更新，请刷新后重试',
          errorCode: FancyNumberErrorCode.QuoteChanged,
        });
      }

      const activeLease = await tx.fancyNumberLease.findFirst({
        where: { userID: userId, endedAt: null },
        select: { id: true },
      });
      if (activeLease) {
        throw new ConflictException({
          message: '当前已有靓号',
          errorCode: FancyNumberErrorCode.AlreadyOwned,
        });
      }

      const fancyNumber = await this.resolvePurchasableTarget(
        tx,
        target,
        userId,
      );
      if (!fancyNumber || fancyNumber.status !== 'AVAILABLE') {
        throw new ConflictException({
          message: '该靓号不可购买',
          errorCode: FancyNumberErrorCode.NotAvailable,
        });
      }

      const claimed = await tx.fancyNumber.updateMany({
        where: { id: fancyNumber.id, status: 'AVAILABLE' },
        data: {
          status: permanent ? 'PERMANENT' : 'LEASED',
          disabledAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          message: '该靓号已被购买',
          errorCode: FancyNumberErrorCode.NotAvailable,
        });
      }

      const reservedOriginal = await tx.accountIdentifier.updateMany({
        where: {
          value: user.accountId,
          currentUserID: userId,
          reservedForUserID: null,
        },
        data: { currentUserID: null, reservedForUserID: userId },
      });
      if (reservedOriginal.count !== 1) {
        throw new ConflictException(
          'Current account identifier is inconsistent',
        );
      }

      const assignedFancy = await tx.accountIdentifier.updateMany({
        where: {
          value: fancyNumber.value,
          currentUserID: null,
          reservedForUserID: null,
          inviteOwnerUserID: null,
        },
        data: { currentUserID: userId },
      });
      if (assignedFancy.count !== 1) {
        throw new ConflictException('Fancy number is not available');
      }

      const initialWallet = await tx.wallet.upsert({
        where: { userID: userId },
        update: {},
        create: { userID: userId },
        select: { balance: true },
      });
      const totalPrice = (normalizedMonths ?? 0) * FANCY_NUMBER_UNIT_PRICE;
      let walletBalanceAfter = initialWallet.balance;
      if (totalPrice > 0) {
        const debited = await tx.wallet.updateMany({
          where: { userID: userId, balance: { gte: totalPrice } },
          data: { balance: { decrement: totalPrice } },
        });
        if (debited.count !== 1) {
          throw new BadRequestException({
            message: '积分不足',
            errorCode: FancyNumberErrorCode.InsufficientPoints,
          });
        }
        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { userID: userId },
          select: { balance: true },
        });
        walletBalanceAfter = wallet.balance;
      }

      const expiresAt =
        normalizedMonths === null
          ? null
          : addUtcCalendarMonths(now, normalizedMonths);
      const lease = await tx.fancyNumberLease.create({
        data: {
          userID: userId,
          fancyNumberID: fancyNumber.id,
          restoreAccountId: user.accountId,
          startedAt: now,
          expiresAt,
          permanentAt: permanent ? now : null,
        },
        select: { id: true, expiresAt: true },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          accountId: fancyNumber.value,
          fancyNumber: true,
          fancyNumberExpiresAt: expiresAt,
          fancyNumberPermanent: permanent,
        },
      });

      const order = await tx.fancyNumberOrder.create({
        data: {
          idempotencyKey: scopedIdempotencyKey,
          requestFingerprint,
          type: 'PURCHASE',
          userID: userId,
          fancyNumberID: fancyNumber.id,
          leaseID: lease.id,
          months: normalizedMonths,
          unitPrice: FANCY_NUMBER_UNIT_PRICE,
          totalPrice,
          walletBalanceAfter,
          newExpiresAt: expiresAt,
        },
        select: { id: true },
      });
      if (totalPrice > 0) {
        await tx.coinTransaction.create({
          data: {
            userID: userId,
            type: 'PURCHASE',
            amount: -totalPrice,
            balance: walletBalanceAfter,
            note: `靓号 ${fancyNumber.value} 购买 ${normalizedMonths} 个月`,
            relatedID: order.id,
            idempotencyKey: `fancy-number:${scopedIdempotencyKey}`,
          },
        });
      }

      return {
        replayed: false,
        result: {
          orderId: order.id,
          accountId: this.displayTargetValue(fancyNumber.value, target),
          expiresAt: lease.expiresAt,
          permanent,
          months: normalizedMonths,
          unitPrice: FANCY_NUMBER_UNIT_PRICE,
          totalPrice,
          walletBalanceAfter,
        },
      };
    });

    if (!replay.replayed) {
      await this.realtime.safeBroadcastAll([
        ...(replay.result.totalPrice > 0
          ? [
              () =>
                this.realtime.broadcastWalletBalanceChanged(userId, {
                  reason: 'PURCHASE',
                  delta: -replay.result.totalPrice,
                }),
            ]
          : []),
        async () => {
          await this.realtime.invalidateUserProfileSummaryCache(userId);
        },
        () => this.realtime.broadcastUserProfileSummary(userId),
      ]);
    }
    return replay.result;
  }

  async switchPermanent(
    userId: string,
    fancyNumberId: string,
    idempotencyKey: string,
    now = new Date(),
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    return this.switchPermanentTarget(
      userId,
      { kind: 'inventory', id: fancyNumberId },
      idempotencyKey,
      now,
      expectedUnitPrice,
    );
  }

  async switchPermanentCustom(
    userId: string,
    value: string,
    idempotencyKey: string,
    now = new Date(),
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    const normalized = this.requireCustomFancyNumber(value);
    return this.switchPermanentTarget(
      userId,
      { kind: 'custom', value: normalized.storedValue },
      idempotencyKey,
      now,
      expectedUnitPrice,
    );
  }

  private async switchPermanentTarget(
    userId: string,
    target: FancyNumberTarget,
    idempotencyKey: string,
    now: Date,
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    const scopedIdempotencyKey = this.clientIdempotencyKey(
      userId,
      idempotencyKey,
    );

    const outcome = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const lease = await tx.fancyNumberLease.findFirst({
          where: { userID: userId, endedAt: null },
          include: {
            user: { select: { accountId: true, status: true } },
            fancyNumber: { select: { id: true, value: true } },
          },
        });
        if (!lease) {
          throw new NotFoundException({
            message: '当前没有可更换的永久靓号',
            errorCode: FancyNumberErrorCode.LeaseNotFound,
          });
        }

        const requestFingerprint = JSON.stringify({
          operation: target.kind === 'custom' ? 'custom-switch' : 'switch',
          userId,
          leaseId: lease.id,
          ...(target.kind === 'custom'
            ? { value: target.value }
            : { fancyNumberId: target.id }),
        });
        const existingOrder = await tx.fancyNumberOrder.findUnique({
          where: { idempotencyKey: scopedIdempotencyKey },
        });
        if (existingOrder) {
          if (existingOrder.requestFingerprint !== requestFingerprint) {
            throw new ConflictException({
              message: '幂等键已用于其他请求',
              errorCode: FancyNumberErrorCode.IdempotencyConflict,
            });
          }
          const switchedNumber = await tx.fancyNumber.findUniqueOrThrow({
            where: { id: existingOrder.fancyNumberID },
            select: { value: true },
          });
          return {
            changed: false,
            result: {
              orderId: existingOrder.id,
              accountId: this.displayTargetValue(switchedNumber.value, target),
              expiresAt: null,
              permanent: true,
              months: null,
              unitPrice: existingOrder.unitPrice,
              totalPrice: existingOrder.totalPrice,
              walletBalanceAfter: existingOrder.walletBalanceAfter ?? 0,
            },
          };
        }
        if (
          expectedUnitPrice !== undefined &&
          expectedUnitPrice !== FANCY_NUMBER_UNIT_PRICE
        ) {
          throw new ConflictException({
            message: '靓号价格已更新，请刷新后重试',
            errorCode: FancyNumberErrorCode.QuoteChanged,
          });
        }

        if (
          lease.permanentAt === null ||
          lease.expiresAt !== null ||
          lease.user.status !== 'ACTIVE'
        ) {
          throw new ConflictException({
            message: '只有永久靓号可以付费更换',
            errorCode: FancyNumberErrorCode.SwitchRequiresPermanent,
          });
        }
        if (lease.user.accountId !== lease.fancyNumber.value) {
          throw new ConflictException(
            'Permanent fancy number account state is inconsistent',
          );
        }

        const targetNumber = await this.resolvePurchasableTarget(
          tx,
          target,
          userId,
        );
        if (!targetNumber || targetNumber.status !== 'AVAILABLE') {
          throw new ConflictException({
            message: '该靓号不可更换',
            errorCode: FancyNumberErrorCode.NotAvailable,
          });
        }

        await tx.wallet.upsert({
          where: { userID: userId },
          update: {},
          create: { userID: userId },
        });
        const debited = await tx.wallet.updateMany({
          where: {
            userID: userId,
            balance: { gte: FANCY_NUMBER_UNIT_PRICE },
          },
          data: { balance: { decrement: FANCY_NUMBER_UNIT_PRICE } },
        });
        if (debited.count !== 1) {
          throw new BadRequestException({
            message: '积分不足',
            errorCode: FancyNumberErrorCode.InsufficientPoints,
          });
        }
        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { userID: userId },
          select: { balance: true },
        });

        const claimedTarget = await tx.fancyNumber.updateMany({
          where: { id: targetNumber.id, status: 'AVAILABLE' },
          data: { status: 'PERMANENT', disabledAt: null },
        });
        if (claimedTarget.count !== 1) {
          throw new ConflictException({
            message: '该靓号已被购买',
            errorCode: FancyNumberErrorCode.NotAvailable,
          });
        }

        const releasedIdentifier = await tx.accountIdentifier.updateMany({
          where: {
            value: lease.fancyNumber.value,
            currentUserID: userId,
          },
          data: { currentUserID: null },
        });
        const assignedIdentifier = await tx.accountIdentifier.updateMany({
          where: {
            value: targetNumber.value,
            currentUserID: null,
            reservedForUserID: null,
            inviteOwnerUserID: null,
          },
          data: { currentUserID: userId },
        });
        if (releasedIdentifier.count !== 1 || assignedIdentifier.count !== 1) {
          throw new ConflictException({
            message: '靓号账号标识状态发生变化，请重试',
            errorCode: FancyNumberErrorCode.InventoryConflict,
          });
        }

        await this.releaseFancyNumberInventory(
          tx,
          lease.fancyNumber.id,
          lease.fancyNumber.value,
          'PERMANENT',
          now,
        );

        await tx.fancyNumberLease.update({
          where: { id: lease.id },
          data: { fancyNumberID: targetNumber.id },
        });
        await tx.user.update({
          where: { id: userId },
          data: {
            accountId: targetNumber.value,
            fancyNumber: true,
            fancyNumberExpiresAt: null,
            fancyNumberPermanent: true,
          },
        });

        const order = await tx.fancyNumberOrder.create({
          data: {
            idempotencyKey: scopedIdempotencyKey,
            requestFingerprint,
            type: 'SWITCH',
            userID: userId,
            fancyNumberID: targetNumber.id,
            leaseID: lease.id,
            months: null,
            unitPrice: FANCY_NUMBER_UNIT_PRICE,
            totalPrice: FANCY_NUMBER_UNIT_PRICE,
            walletBalanceAfter: wallet.balance,
            previousExpiresAt: null,
            newExpiresAt: null,
          },
          select: { id: true },
        });
        await tx.coinTransaction.create({
          data: {
            userID: userId,
            type: 'PURCHASE',
            amount: -FANCY_NUMBER_UNIT_PRICE,
            balance: wallet.balance,
            note: `永久靓号 ${lease.fancyNumber.value} 更换为 ${targetNumber.value}`,
            relatedID: order.id,
            idempotencyKey: `fancy-number:${scopedIdempotencyKey}`,
          },
        });

        return {
          changed: true,
          result: {
            orderId: order.id,
            accountId: this.displayTargetValue(targetNumber.value, target),
            expiresAt: null,
            permanent: true,
            months: null,
            unitPrice: FANCY_NUMBER_UNIT_PRICE,
            totalPrice: FANCY_NUMBER_UNIT_PRICE,
            walletBalanceAfter: wallet.balance,
          },
        };
      },
    );

    if (outcome.changed) {
      await this.realtime.safeBroadcastAll([
        () =>
          this.realtime.broadcastWalletBalanceChanged(userId, {
            reason: 'PURCHASE',
            delta: -FANCY_NUMBER_UNIT_PRICE,
          }),
        async () => {
          await this.realtime.invalidateUserProfileSummaryCache(userId);
        },
        () => this.realtime.broadcastUserProfileSummary(userId),
      ]);
    }
    return outcome.result;
  }

  async renew(
    userId: string,
    months: number,
    idempotencyKey: string,
    now = new Date(),
    expectedUnitPrice?: number,
  ): Promise<FancyNumberPurchaseResult> {
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      throw new BadRequestException({
        message: '续费月数必须是 1 到 12 的整数',
        errorCode: FancyNumberErrorCode.InvalidMonths,
      });
    }
    const scopedIdempotencyKey = this.clientIdempotencyKey(
      userId,
      idempotencyKey,
    );
    if (await this.expireOverdueLeaseForUser(userId, now)) {
      throw new ConflictException({
        message: '靓号已到期并恢复原账号',
        errorCode: FancyNumberErrorCode.LeaseExpired,
      });
    }

    const replay = await runSerializableTransaction(this.prisma, async (tx) => {
      const lease = await tx.fancyNumberLease.findFirst({
        where: { userID: userId, endedAt: null },
        include: {
          fancyNumber: { select: { id: true, value: true } },
        },
      });
      if (!lease) {
        throw new NotFoundException({
          message: '当前没有可续费的靓号',
          errorCode: FancyNumberErrorCode.LeaseNotFound,
        });
      }
      const requestFingerprint = JSON.stringify({
        operation: 'renewal',
        userId,
        leaseId: lease.id,
        months,
      });
      const existingOrder = await tx.fancyNumberOrder.findUnique({
        where: { idempotencyKey: scopedIdempotencyKey },
      });
      if (existingOrder) {
        if (existingOrder.requestFingerprint !== requestFingerprint) {
          throw new ConflictException({
            message: '幂等键已用于其他请求',
            errorCode: FancyNumberErrorCode.IdempotencyConflict,
          });
        }
        return {
          replayed: true,
          result: {
            orderId: existingOrder.id,
            accountId: lease.fancyNumber.value,
            expiresAt: existingOrder.newExpiresAt,
            permanent: false,
            months: existingOrder.months,
            unitPrice: existingOrder.unitPrice,
            totalPrice: existingOrder.totalPrice,
            walletBalanceAfter: existingOrder.walletBalanceAfter ?? 0,
          },
        };
      }
      if (
        expectedUnitPrice !== undefined &&
        expectedUnitPrice !== FANCY_NUMBER_UNIT_PRICE
      ) {
        throw new ConflictException({
          message: '靓号价格已更新，请刷新后重试',
          errorCode: FancyNumberErrorCode.QuoteChanged,
        });
      }
      if (lease.permanentAt !== null || lease.expiresAt === null) {
        throw new ConflictException({
          message: '永久靓号无需续费',
          errorCode: FancyNumberErrorCode.PermanentCannotRenew,
        });
      }
      if (lease.expiresAt.getTime() <= now.getTime()) {
        throw new ConflictException({
          message: '靓号已到期',
          errorCode: FancyNumberErrorCode.LeaseExpired,
        });
      }

      const totalPrice = months * FANCY_NUMBER_UNIT_PRICE;
      await tx.wallet.upsert({
        where: { userID: userId },
        update: {},
        create: { userID: userId },
      });
      const debited = await tx.wallet.updateMany({
        where: { userID: userId, balance: { gte: totalPrice } },
        data: { balance: { decrement: totalPrice } },
      });
      if (debited.count !== 1) {
        throw new BadRequestException({
          message: '积分不足',
          errorCode: FancyNumberErrorCode.InsufficientPoints,
        });
      }
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userID: userId },
        select: { balance: true },
      });
      const expiresAt = addUtcCalendarMonths(lease.expiresAt, months);
      const updatedLease = await tx.fancyNumberLease.update({
        where: { id: lease.id },
        data: { expiresAt },
        select: { expiresAt: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: { fancyNumberExpiresAt: expiresAt },
      });
      const order = await tx.fancyNumberOrder.create({
        data: {
          idempotencyKey: scopedIdempotencyKey,
          requestFingerprint,
          type: 'RENEWAL',
          userID: userId,
          fancyNumberID: lease.fancyNumber.id,
          leaseID: lease.id,
          months,
          unitPrice: FANCY_NUMBER_UNIT_PRICE,
          totalPrice,
          walletBalanceAfter: wallet.balance,
          previousExpiresAt: lease.expiresAt,
          newExpiresAt: expiresAt,
        },
        select: { id: true },
      });
      await tx.coinTransaction.create({
        data: {
          userID: userId,
          type: 'PURCHASE',
          amount: -totalPrice,
          balance: wallet.balance,
          note: `靓号 ${lease.fancyNumber.value} 续费 ${months} 个月`,
          relatedID: order.id,
          idempotencyKey: `fancy-number:${scopedIdempotencyKey}`,
        },
      });

      return {
        replayed: false,
        result: {
          orderId: order.id,
          accountId: lease.fancyNumber.value,
          expiresAt: updatedLease.expiresAt,
          permanent: false,
          months,
          unitPrice: FANCY_NUMBER_UNIT_PRICE,
          totalPrice,
          walletBalanceAfter: wallet.balance,
        },
      };
    });

    if (!replay.replayed) {
      await this.realtime.safeBroadcastAll([
        () =>
          this.realtime.broadcastWalletBalanceChanged(userId, {
            reason: 'PURCHASE',
            delta: -replay.result.totalPrice,
          }),
      ]);
    }
    return replay.result;
  }

  async expireLease(leaseId: string, now = new Date()): Promise<boolean> {
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const lease = await tx.fancyNumberLease.findUnique({
        where: { id: leaseId },
        include: {
          user: { select: { accountId: true } },
          fancyNumber: { select: { value: true } },
        },
      });
      if (
        !lease ||
        lease.endedAt !== null ||
        lease.permanentAt !== null ||
        lease.expiresAt === null ||
        lease.expiresAt.getTime() > now.getTime()
      ) {
        return { expired: false, userId: null };
      }
      if (
        lease.restoreAccountId === null ||
        lease.user.accountId !== lease.fancyNumber.value
      ) {
        throw new ConflictException(
          'Fancy number lease account state is inconsistent',
        );
      }

      const closed = await tx.fancyNumberLease.updateMany({
        where: {
          id: lease.id,
          endedAt: null,
          permanentAt: null,
          expiresAt: { lte: now },
        },
        data: { endedAt: now, endReason: 'EXPIRED' },
      });
      if (closed.count !== 1) {
        return { expired: false, userId: null };
      }

      const releasedFancy = await tx.accountIdentifier.updateMany({
        where: {
          value: lease.fancyNumber.value,
          currentUserID: lease.userID,
        },
        data: { currentUserID: null },
      });
      const restoredOriginal = await tx.accountIdentifier.updateMany({
        where: {
          value: lease.restoreAccountId,
          currentUserID: null,
          reservedForUserID: lease.userID,
        },
        data: {
          currentUserID: lease.userID,
          reservedForUserID: null,
        },
      });
      if (releasedFancy.count !== 1 || restoredOriginal.count !== 1) {
        throw new ConflictException(
          'Fancy number account identifiers are inconsistent',
        );
      }

      await tx.user.update({
        where: { id: lease.userID },
        data: {
          accountId: lease.restoreAccountId,
          fancyNumber: false,
          fancyNumberExpiresAt: null,
          fancyNumberPermanent: false,
        },
      });
      await this.releaseFancyNumberInventory(
        tx,
        lease.fancyNumberID,
        lease.fancyNumber.value,
        'LEASED',
        now,
      );
      return { expired: true, userId: lease.userID };
    });

    if (result.expired && result.userId) {
      const expiredUserId = result.userId;
      await this.realtime.safeBroadcastAll([
        async () => {
          await this.realtime.invalidateUserProfileSummaryCache(expiredUserId);
        },
        () => this.realtime.broadcastUserProfileSummary(expiredUserId),
      ]);
    }
    return result.expired;
  }

  async expireDue(now = new Date()): Promise<number> {
    const due = await this.prisma.fancyNumberLease.findMany({
      where: {
        endedAt: null,
        permanentAt: null,
        expiresAt: { lte: now },
      },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    let expired = 0;
    for (const lease of due) {
      try {
        if (await this.expireLease(lease.id, now)) {
          expired += 1;
        }
      } catch (error) {
        this.logger.error(
          `Failed to expire fancy-number lease ${lease.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return expired;
  }

  async adminBatchCreate(
    actorId: string,
    values: string[],
  ): Promise<Array<{ id: string; value: string }>> {
    const normalized = [
      ...new Set(values.map((value) => value.trim().toLowerCase())),
    ].sort((left, right) => left.localeCompare(right));
    if (
      normalized.length < 1 ||
      normalized.length > 100 ||
      normalized.some((value) => !ACCOUNT_ID_PATTERN.test(value))
    ) {
      throw new BadRequestException('Invalid fancy number inventory batch');
    }

    try {
      return await runSerializableTransaction(this.prisma, async (tx) => {
        const conflicts = await tx.accountIdentifier.findMany({
          where: { value: { in: normalized } },
          select: { value: true },
        });
        if (conflicts.length > 0) {
          throw new ConflictException(
            `Account identifier is already occupied: ${conflicts[0].value}`,
          );
        }

        await tx.accountIdentifier.createMany({
          data: normalized.map((value) => ({ value })),
        });
        await tx.fancyNumber.createMany({
          data: normalized.map((value, sortOrder) => ({
            value,
            source: 'ADMIN',
            status: 'AVAILABLE',
            createdByUserID: actorId,
            sortOrder,
          })),
        });
        await tx.adminAuditLog.create({
          data: {
            actorID: actorId,
            action: 'FANCY_NUMBER_BATCH_CREATE',
            entityType: 'FancyNumber',
            metadata: { count: normalized.length, values: normalized },
          },
        });
        return tx.fancyNumber.findMany({
          where: { value: { in: normalized } },
          select: { id: true, value: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        });
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          'One or more account identifiers are already occupied',
        );
      }
      throw error;
    }
  }

  async adminList(query: {
    cursor?: string;
    limit?: number;
    status?: 'AVAILABLE' | 'LEASED' | 'PERMANENT' | 'DISABLED';
    search?: string;
  }) {
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new BadRequestException('limit must be an integer from 1 to 50');
    }
    const rows = await this.prisma.fancyNumber.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? { value: { contains: query.search.trim().toLowerCase() } }
          : {}),
      },
      select: {
        id: true,
        value: true,
        status: true,
        source: true,
        disabledAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async adminListRecommendations() {
    return {
      items: this.displayRecommendationRows(
        await this.prisma.fancyNumber.findMany({
          where: { isRecommended: true },
          select: FANCY_NUMBER_RECOMMENDATION_SELECT,
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          take: FANCY_NUMBER_RECOMMENDATION_LIMIT + 1,
        }),
      ),
    };
  }

  async adminAddRecommendations(actorId: string, values: string[]) {
    const normalized = values.map(
      (value) => this.requireCustomFancyNumber(value).storedValue,
    );
    if (
      normalized.length < 1 ||
      normalized.length > FANCY_NUMBER_RECOMMENDATION_LIMIT ||
      new Set(normalized).size !== normalized.length
    ) {
      throw new BadRequestException('Invalid fancy number recommendations');
    }

    try {
      return await runSerializableTransaction(this.prisma, async (tx) => {
        await this.lockRecommendations(tx);

        const existingNumbers = await tx.fancyNumber.findMany({
          where: { value: { in: normalized } },
          select: { id: true, value: true, isRecommended: true },
        });
        const existingByValue = new Map(
          existingNumbers.map((number) => [number.value, number]),
        );
        const identifiers = await tx.accountIdentifier.findMany({
          where: { value: { in: normalized } },
          select: { value: true },
        });
        const occupiedIdentifier = identifiers.find(
          (identifier) => !existingByValue.has(identifier.value),
        );
        if (occupiedIdentifier) {
          throw new ConflictException({
            message: `账号标识已被占用：${occupiedIdentifier.value}`,
            errorCode: FancyNumberErrorCode.RecommendationAccountOccupied,
          });
        }

        const valuesToAppend = normalized.filter(
          (value) => !existingByValue.get(value)?.isRecommended,
        );
        const currentCount = await tx.fancyNumber.count({
          where: { isRecommended: true },
        });
        if (
          currentCount + valuesToAppend.length >
          FANCY_NUMBER_RECOMMENDATION_LIMIT
        ) {
          throw new ConflictException({
            message: '热门靓号推荐最多 100 个',
            errorCode: FancyNumberErrorCode.RecommendationLimit,
          });
        }

        const last = await tx.fancyNumber.findFirst({
          where: { isRecommended: true },
          select: { sortOrder: true },
          orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }],
        });
        const firstSortOrder = (last?.sortOrder ?? -1) + 1;
        const newValues = valuesToAppend.filter(
          (value) => !existingByValue.has(value),
        );
        if (newValues.length > 0) {
          await tx.accountIdentifier.createMany({
            data: newValues.map((value) => ({ value })),
          });
        }

        for (const [index, value] of valuesToAppend.entries()) {
          const existing = existingByValue.get(value);
          if (existing) {
            await tx.fancyNumber.update({
              where: { id: existing.id },
              data: {
                isRecommended: true,
                sortOrder: firstSortOrder + index,
              },
            });
          }
        }

        if (newValues.length > 0) {
          const positions = new Map(
            valuesToAppend.map((value, index) => [
              value,
              firstSortOrder + index,
            ]),
          );
          await tx.fancyNumber.createMany({
            data: newValues.map((value) => ({
              value,
              source: 'ADMIN',
              status: 'AVAILABLE',
              createdByUserID: actorId,
              isRecommended: true,
              sortOrder: positions.get(value) ?? firstSortOrder,
            })),
          });
        }

        const items = await this.listRecommendationRows(tx);
        const appended = items
          .filter((item) => valuesToAppend.includes(item.value))
          .map((item) => ({
            id: item.id,
            value: item.value,
            sortOrder: item.sortOrder,
          }));
        await tx.adminAuditLog.create({
          data: {
            actorID: actorId,
            action: 'FANCY_NUMBER_RECOMMENDATIONS_ADDED',
            entityType: 'FancyNumberRecommendation',
            metadata: {
              requestedValues: normalized,
              appended,
            },
          },
        });
        return { items: this.displayRecommendationRows(items) };
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: '一个或多个账号标识已被占用',
          errorCode: FancyNumberErrorCode.RecommendationAccountOccupied,
        });
      }
      throw error;
    }
  }

  async adminSetRecommendation(
    actorId: string,
    fancyNumberId: string,
    recommended: boolean,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockRecommendations(tx);
      const current = await tx.fancyNumber.findUnique({
        where: { id: fancyNumberId },
        select: FANCY_NUMBER_RECOMMENDATION_SELECT,
      });
      if (!current) {
        throw new NotFoundException({
          message: '靓号不存在',
          errorCode: FancyNumberErrorCode.RecommendationNotFound,
        });
      }

      let sortOrder = current.sortOrder;
      if (recommended && !current.isRecommended) {
        const count = await tx.fancyNumber.count({
          where: { isRecommended: true },
        });
        if (count >= FANCY_NUMBER_RECOMMENDATION_LIMIT) {
          throw new ConflictException({
            message: '热门靓号推荐最多 100 个',
            errorCode: FancyNumberErrorCode.RecommendationLimit,
          });
        }
        const last = await tx.fancyNumber.findFirst({
          where: { isRecommended: true },
          select: { sortOrder: true },
          orderBy: [{ sortOrder: 'desc' }, { id: 'desc' }],
        });
        sortOrder = (last?.sortOrder ?? -1) + 1;
      }

      const updated = await tx.fancyNumber.update({
        where: { id: fancyNumberId },
        data: recommended
          ? { isRecommended: true, sortOrder }
          : { isRecommended: false },
        select: FANCY_NUMBER_RECOMMENDATION_SELECT,
      });
      await tx.adminAuditLog.create({
        data: {
          actorID: actorId,
          action: recommended
            ? 'FANCY_NUMBER_RECOMMENDATION_ENABLED'
            : 'FANCY_NUMBER_RECOMMENDATION_DISABLED',
          entityType: 'FancyNumberRecommendation',
          entityID: fancyNumberId,
          before: {
            isRecommended: current.isRecommended,
            sortOrder: current.sortOrder,
          },
          after: {
            isRecommended: updated.isRecommended,
            sortOrder: updated.sortOrder,
          },
        },
      });
      return this.displayRecommendationRow(updated);
    });
  }

  async adminReorderRecommendations(
    actorId: string,
    expectedIds: string[],
    ids: string[],
  ) {
    if (
      expectedIds.length > FANCY_NUMBER_RECOMMENDATION_LIMIT ||
      ids.length !== expectedIds.length ||
      new Set(expectedIds).size !== expectedIds.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !expectedIds.includes(id))
    ) {
      throw new BadRequestException({
        message: '热门靓号排序参数无效',
        errorCode: FancyNumberErrorCode.RecommendationInvalidOrder,
      });
    }

    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockRecommendations(tx);
      const current = await tx.fancyNumber.findMany({
        where: { isRecommended: true },
        select: { id: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        take: FANCY_NUMBER_RECOMMENDATION_LIMIT + 1,
      });
      const currentIds = current.map((item) => item.id);
      if (
        currentIds.length !== expectedIds.length ||
        currentIds.some((id, index) => id !== expectedIds[index])
      ) {
        throw new ConflictException({
          message: '热门靓号列表已被其他管理员修改，请刷新后重试',
          errorCode: FancyNumberErrorCode.RecommendationConflict,
        });
      }

      for (const [sortOrder, id] of ids.entries()) {
        await tx.fancyNumber.update({
          where: { id },
          data: { sortOrder },
        });
      }
      await tx.adminAuditLog.create({
        data: {
          actorID: actorId,
          action: 'FANCY_NUMBER_RECOMMENDATIONS_REORDERED',
          entityType: 'FancyNumberRecommendation',
          before: { ids: currentIds },
          after: { ids },
        },
      });
      return {
        items: this.displayRecommendationRows(
          await this.listRecommendationRows(tx),
        ),
      };
    });
  }

  async adminSetAvailability(
    actorId: string,
    fancyNumberId: string,
    enabled: boolean,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const current = await tx.fancyNumber.findUnique({
        where: { id: fancyNumberId },
      });
      if (!current) {
        throw new NotFoundException('Fancy number not found');
      }
      if (current.status === 'LEASED' || current.status === 'PERMANENT') {
        throw new ConflictException(
          'Leased or permanent fancy numbers cannot be disabled',
        );
      }
      const status = enabled ? 'AVAILABLE' : 'DISABLED';
      const disabledAt = enabled ? null : new Date();
      const updated = await tx.fancyNumber.update({
        where: { id: fancyNumberId },
        data: { status, disabledAt },
      });
      await tx.adminAuditLog.create({
        data: {
          actorID: actorId,
          action: enabled ? 'FANCY_NUMBER_ENABLED' : 'FANCY_NUMBER_DISABLED',
          entityType: 'FancyNumber',
          entityID: fancyNumberId,
          before: { status: current.status },
          after: { status },
        },
      });
      return updated;
    });
  }

  private async lockRecommendations(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FANCY_NUMBER_RECOMMENDATION_LOCK}))`;
  }

  private listRecommendationRows(
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<FancyNumberRecommendationRow[]> {
    return client.fancyNumber.findMany({
      where: { isRecommended: true },
      select: FANCY_NUMBER_RECOMMENDATION_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: FANCY_NUMBER_RECOMMENDATION_LIMIT + 1,
    });
  }

  private displayRecommendationRows(
    rows: FancyNumberRecommendationRow[],
  ): Array<FancyNumberRecommendationRow & { value: string }> {
    return rows.map((row) => this.displayRecommendationRow(row));
  }

  private displayRecommendationRow(
    row: FancyNumberRecommendationRow,
  ): FancyNumberRecommendationRow & { value: string } {
    return { ...row, value: row.value.toUpperCase() };
  }

  private requireCustomFancyNumber(value: string): {
    displayValue: string;
    storedValue: string;
  } {
    const normalized = normalizeCustomFancyNumber(value);
    if (!CUSTOM_FANCY_NUMBER_PATTERN.test(normalized.displayValue)) {
      throw new BadRequestException({
        message: '靓号必须是 6 位英文字母或数字',
        errorCode: FancyNumberErrorCode.InvalidValue,
      });
    }
    try {
      return validateCustomFancyNumber(normalized.displayValue);
    } catch {
      throw new BadRequestException({
        message: '该靓号不可使用',
        errorCode: FancyNumberErrorCode.ReservedValue,
      });
    }
  }

  private async resolvePurchasableTarget(
    tx: Prisma.TransactionClient,
    target: FancyNumberTarget,
    userId: string,
  ): Promise<{ id: string; value: string; status: string } | null> {
    if (target.kind === 'inventory') {
      const inventoryNumber = await tx.fancyNumber.findUnique({
        where: { id: target.id },
        select: { id: true, value: true, status: true },
      });
      if (
        !inventoryNumber ||
        (await this.hasAccountIdentifierClaim(tx, inventoryNumber.value))
      ) {
        return null;
      }
      return inventoryNumber;
    }

    const existingFancyNumber = await tx.fancyNumber.findUnique({
      where: { value: target.value },
      select: { id: true, value: true, status: true },
    });
    if (existingFancyNumber) {
      if (await this.hasAccountIdentifierClaim(tx, existingFancyNumber.value)) {
        return null;
      }
      return existingFancyNumber;
    }

    const existingIdentifier = await tx.accountIdentifier.findUnique({
      where: { value: target.value },
      select: { value: true },
    });
    if (existingIdentifier) {
      throw new ConflictException({
        message: '该靓号已被占用',
        errorCode: FancyNumberErrorCode.NotAvailable,
      });
    }

    try {
      await tx.accountIdentifier.create({
        data: { value: target.value },
      });
      return await tx.fancyNumber.create({
        data: {
          value: target.value,
          source: 'CUSTOM',
          status: 'AVAILABLE',
          createdByUserID: userId,
        },
        select: { id: true, value: true, status: true },
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: '该靓号已被占用',
          errorCode: FancyNumberErrorCode.NotAvailable,
        });
      }
      throw error;
    }
  }

  private displayTargetValue(
    storedValue: string,
    target: FancyNumberTarget,
  ): string {
    return target.kind === 'custom' ? storedValue.toUpperCase() : storedValue;
  }

  private clientIdempotencyKey(userId: string, value: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > 128) {
      throw new BadRequestException({
        message: '无效的 Idempotency-Key',
        errorCode: FancyNumberErrorCode.InvalidIdempotencyKey,
      });
    }
    return `client:${userId}:${normalized}`;
  }

  private async hasAccountIdentifierClaim(
    tx: Prisma.TransactionClient,
    value: string,
  ): Promise<boolean> {
    const identifier = await tx.accountIdentifier.findUnique({
      where: { value },
      select: {
        currentUserID: true,
        reservedForUserID: true,
        inviteOwnerUserID: true,
      },
    });
    return (
      !identifier ||
      identifier.currentUserID !== null ||
      identifier.reservedForUserID !== null ||
      identifier.inviteOwnerUserID !== null
    );
  }

  private async releaseFancyNumberInventory(
    tx: Prisma.TransactionClient,
    fancyNumberId: string,
    value: string,
    expectedStatus: 'LEASED' | 'PERMANENT',
    now: Date,
  ): Promise<void> {
    const identifier = await tx.accountIdentifier.findUnique({
      where: { value },
      select: {
        currentUserID: true,
        reservedForUserID: true,
        inviteOwnerUserID: true,
      },
    });
    if (!identifier || identifier.currentUserID !== null) {
      throw new ConflictException({
        message: '原靓号账号标识状态发生变化，请重试',
        errorCode: FancyNumberErrorCode.InventoryConflict,
      });
    }
    const hasDurableClaim =
      identifier.reservedForUserID !== null ||
      identifier.inviteOwnerUserID !== null;
    const released = await tx.fancyNumber.updateMany({
      where: { id: fancyNumberId, status: expectedStatus },
      data: hasDurableClaim
        ? { status: 'DISABLED', disabledAt: now }
        : { status: 'AVAILABLE', disabledAt: null },
    });
    if (released.count !== 1) {
      throw new ConflictException({
        message: '原靓号状态发生变化，请重试',
        errorCode: FancyNumberErrorCode.InventoryConflict,
      });
    }
  }

  private async expireOverdueLeaseForUser(
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const dueLease = await this.prisma.fancyNumberLease.findFirst({
      where: {
        userID: userId,
        endedAt: null,
        permanentAt: null,
        expiresAt: { lte: now },
      },
      select: { id: true },
    });
    return dueLease ? this.expireLease(dueLease.id, now) : false;
  }

  private async restoreExpiredLeaseInTransaction(
    tx: Prisma.TransactionClient,
    lease: {
      id: string;
      userID: string;
      fancyNumberID: string;
      restoreAccountId: string | null;
      expiresAt: Date | null;
      permanentAt: Date | null;
      user: { accountId: string };
      fancyNumber: { value: string };
    },
    now: Date,
  ): Promise<void> {
    if (
      lease.restoreAccountId === null ||
      lease.user.accountId !== lease.fancyNumber.value
    ) {
      throw new ConflictException(
        'Fancy number lease account state is inconsistent',
      );
    }
    const closed = await tx.fancyNumberLease.updateMany({
      where: {
        id: lease.id,
        endedAt: null,
        permanentAt: null,
        expiresAt: { lte: now },
      },
      data: { endedAt: now, endReason: 'EXPIRED' },
    });
    if (closed.count !== 1) {
      throw new ConflictException({
        message: '靓号租期状态已变化，请重试',
        errorCode: FancyNumberErrorCode.LeaseExpired,
      });
    }
    const releasedFancy = await tx.accountIdentifier.updateMany({
      where: {
        value: lease.fancyNumber.value,
        currentUserID: lease.userID,
      },
      data: { currentUserID: null },
    });
    const restoredOriginal = await tx.accountIdentifier.updateMany({
      where: {
        value: lease.restoreAccountId,
        currentUserID: null,
        reservedForUserID: lease.userID,
      },
      data: {
        currentUserID: lease.userID,
        reservedForUserID: null,
      },
    });
    if (releasedFancy.count !== 1 || restoredOriginal.count !== 1) {
      throw new ConflictException(
        'Fancy number account identifiers are inconsistent',
      );
    }
    await tx.user.update({
      where: { id: lease.userID },
      data: {
        accountId: lease.restoreAccountId,
        fancyNumber: false,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: false,
      },
    });
    await this.releaseFancyNumberInventory(
      tx,
      lease.fancyNumberID,
      lease.fancyNumber.value,
      'LEASED',
      now,
    );
  }

  private inactiveFancyNumber() {
    return {
      active: false,
      accountId: null,
      restoreAccountId: null,
      startedAt: null,
      expiresAt: null,
      permanent: false,
      renewable: false,
      unitPrice: FANCY_NUMBER_UNIT_PRICE,
    };
  }
}
