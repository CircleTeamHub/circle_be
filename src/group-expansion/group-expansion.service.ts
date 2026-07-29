import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupExpansionErrorCode } from 'src/common/app-error-codes';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import {
  GROUP_EXPANSION_PRODUCTS,
  GroupExpansionProductId,
  getGroupExpansionProduct,
} from './group-expansion.catalog';

const GROUP_CAPACITY_HARD_LIMIT = 3000;

interface StoredExpansionOrder {
  id: string;
  requestFingerprint: string;
  circleID: string;
  productID: string;
  productName: string;
  seats: number;
  price: number;
  previousMaxMembers: number;
  newMaxMembers: number;
  walletBalanceAfter: number;
}

export interface GroupExpansionPurchaseResult {
  orderId: string;
  circleId: string;
  productId: string;
  productName: string;
  seats: number;
  price: number;
  previousMaxMembers: number;
  newMaxMembers: number;
  walletBalanceAfter: number;
}

export interface GroupExpansionProductsResult {
  circleId: string;
  memberCount: number;
  currentMaxMembers: number;
  expansionSeats: number;
  hardLimit: number;
  products: Array<{
    id: GroupExpansionProductId;
    name: string;
    seats: number;
    price: number;
    purchasable: boolean;
    unavailableReason: 'MAX_CAPACITY_EXCEEDED' | null;
    resultingMaxMembers: number;
  }>;
}

export interface GroupExpansionOrdersResult {
  items: Array<{
    orderId: string;
    circleId: string;
    productId: string;
    productName: string;
    seats: number;
    price: number;
    previousMaxMembers: number;
    newMaxMembers: number;
    walletBalanceAfter: number;
    createdAt: Date;
  }>;
  nextCursor: string | null;
}

@Injectable()
export class GroupExpansionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membershipPolicy: MembershipPolicyService,
    private readonly realtime: RealtimeService,
  ) {}

  async getProducts(
    userId: string,
    circleId: string,
    now = new Date(),
  ): Promise<GroupExpansionProductsResult> {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, ownerID: userId, deleted: false },
      select: {
        id: true,
        maxMembers: true,
        expansionSeats: true,
        memberCount: true,
      },
    });
    if (!circle) {
      throw new NotFoundException({
        message: '群不存在',
        errorCode: GroupExpansionErrorCode.CircleNotFound,
      });
    }
    const entitlement = await this.membershipPolicy.getUserPolicy(userId, now);
    const baseCapacity = entitlement.tier.quotas.groupMembers.actual;
    const configuredCapacity = Math.min(
      circle.maxMembers ?? baseCapacity,
      GROUP_CAPACITY_HARD_LIMIT,
    );
    const currentEffectiveCapacity = this.effectiveCapacity(
      configuredCapacity,
      baseCapacity,
      circle.expansionSeats,
    );

    return {
      circleId: circle.id,
      memberCount: circle.memberCount,
      currentMaxMembers: currentEffectiveCapacity,
      expansionSeats: circle.expansionSeats,
      hardLimit: GROUP_CAPACITY_HARD_LIMIT,
      products: GROUP_EXPANSION_PRODUCTS.map((product) => {
        const nextConfiguredCapacity = Math.min(
          configuredCapacity + product.seats,
          GROUP_CAPACITY_HARD_LIMIT,
        );
        const nextEffectiveCapacity = this.effectiveCapacity(
          nextConfiguredCapacity,
          baseCapacity,
          circle.expansionSeats + product.seats,
        );
        const purchasable =
          nextEffectiveCapacity - currentEffectiveCapacity === product.seats;
        return {
          ...product,
          purchasable,
          unavailableReason: purchasable
            ? null
            : ('MAX_CAPACITY_EXCEEDED' as const),
          resultingMaxMembers: nextEffectiveCapacity,
        };
      }),
    };
  }

  async getOrders(
    userId: string,
    circleId: string,
    cursor?: string,
    limit = 20,
  ): Promise<GroupExpansionOrdersResult> {
    const circle = await this.prisma.circle.findFirst({
      where: { id: circleId, ownerID: userId, deleted: false },
      select: { id: true },
    });
    if (!circle) {
      throw new NotFoundException({
        message: '群不存在',
        errorCode: GroupExpansionErrorCode.CircleNotFound,
      });
    }

    const rows = await this.prisma.groupExpansionOrder.findMany({
      where: { userID: userId, circleID: circleId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    return {
      items: visibleRows.map((order) => ({
        orderId: order.id,
        circleId: order.circleID,
        productId: order.productID,
        productName: order.productName,
        seats: order.seats,
        price: order.price,
        previousMaxMembers: order.previousMaxMembers,
        newMaxMembers: order.newMaxMembers,
        walletBalanceAfter: order.walletBalanceAfter,
        createdAt: order.createdAt,
      })),
      nextCursor:
        hasMore && visibleRows.length > 0
          ? visibleRows[visibleRows.length - 1].id
          : null,
    };
  }

  async purchase(
    userId: string,
    circleId: string,
    productId: GroupExpansionProductId,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<GroupExpansionPurchaseResult> {
    const product = getGroupExpansionProduct(productId);
    if (!product) {
      throw new BadRequestException({
        message: '扩容商品不存在',
        errorCode: GroupExpansionErrorCode.ProductNotFound,
      });
    }

    const scopedIdempotencyKey = `client:${userId}:${idempotencyKey}`;
    const requestFingerprint = `${circleId}:${product.id}`;

    let transactionResult: {
      purchase: GroupExpansionPurchaseResult;
      created: boolean;
    };
    try {
      transactionResult = await runSerializableTransaction(
        this.prisma,
        async (tx) => {
          const prior = await tx.groupExpansionOrder.findUnique({
            where: { idempotencyKey: scopedIdempotencyKey },
          });
          if (prior) {
            return {
              purchase: this.restorePrior(prior, requestFingerprint),
              created: false,
            };
          }

          const circle = await tx.circle.findFirst({
            where: { id: circleId, ownerID: userId, deleted: false },
            select: {
              id: true,
              maxMembers: true,
              expansionSeats: true,
              memberCount: true,
            },
          });
          if (!circle) {
            throw new NotFoundException({
              message: '群不存在',
              errorCode: GroupExpansionErrorCode.CircleNotFound,
            });
          }

          const membership = await tx.user.findUnique({
            where: { id: userId },
            select: { vipLevel: true, vipExpiresAt: true },
          });
          if (!membership) {
            throw new NotFoundException({
              message: '群不存在',
              errorCode: GroupExpansionErrorCode.CircleNotFound,
            });
          }
          const entitlement = await this.membershipPolicy.resolveEntitlement(
            membership,
            tx,
            now,
            { lockForWrite: true },
          );
          const baseCapacity = entitlement.tier.quotas.groupMembers.actual;
          const configuredCapacity = Math.min(
            circle.maxMembers ?? baseCapacity,
            GROUP_CAPACITY_HARD_LIMIT,
          );
          const currentEffectiveCapacity = this.effectiveCapacity(
            configuredCapacity,
            baseCapacity,
            circle.expansionSeats,
          );
          const nextExpansionSeats = circle.expansionSeats + product.seats;
          const nextConfiguredCapacity = Math.min(
            configuredCapacity + product.seats,
            GROUP_CAPACITY_HARD_LIMIT,
          );
          const nextEffectiveCapacity = this.effectiveCapacity(
            nextConfiguredCapacity,
            baseCapacity,
            nextExpansionSeats,
          );
          if (
            nextEffectiveCapacity - currentEffectiveCapacity !==
            product.seats
          ) {
            throw new ConflictException({
              message: '该扩容卡会超过 3000 人上限',
              errorCode: GroupExpansionErrorCode.CapacityExceeded,
              limit: GROUP_CAPACITY_HARD_LIMIT,
              details: { limit: GROUP_CAPACITY_HARD_LIMIT },
            });
          }

          await tx.wallet.upsert({
            where: { userID: userId },
            update: {},
            create: { userID: userId },
            select: { balance: true },
          });
          const debited = await tx.wallet.updateMany({
            where: { userID: userId, balance: { gte: product.price } },
            data: { balance: { decrement: product.price } },
          });
          if (debited.count !== 1) {
            throw new BadRequestException({
              message: '积分不足',
              errorCode: GroupExpansionErrorCode.InsufficientPoints,
            });
          }
          const wallet = await tx.wallet.findUniqueOrThrow({
            where: { userID: userId },
            select: { balance: true },
          });

          await tx.circle.update({
            where: { id: circleId },
            data: {
              expansionSeats: { increment: product.seats },
              maxMembers: nextConfiguredCapacity,
            },
          });
          const order = await tx.groupExpansionOrder.create({
            data: {
              idempotencyKey: scopedIdempotencyKey,
              requestFingerprint,
              userID: userId,
              circleID: circleId,
              productID: product.id,
              productName: product.name,
              seats: product.seats,
              price: product.price,
              previousMaxMembers: currentEffectiveCapacity,
              newMaxMembers: nextEffectiveCapacity,
              walletBalanceAfter: wallet.balance,
            },
            select: { id: true },
          });
          await tx.coinTransaction.create({
            data: {
              userID: userId,
              type: 'PURCHASE',
              amount: -product.price,
              balance: wallet.balance,
              note: `${product.name}：群永久扩容 ${product.seats} 人`,
              relatedID: order.id,
              idempotencyKey: `group-expansion:${scopedIdempotencyKey}`,
            },
          });

          return {
            purchase: {
              orderId: order.id,
              circleId,
              productId: product.id,
              productName: product.name,
              seats: product.seats,
              price: product.price,
              previousMaxMembers: currentEffectiveCapacity,
              newMaxMembers: nextEffectiveCapacity,
              walletBalanceAfter: wallet.balance,
            },
            created: true,
          };
        },
      );
    } catch (error) {
      if (prismaErrorCode(error) !== 'P2002') {
        throw error;
      }
      const prior = await this.prisma.groupExpansionOrder.findUnique({
        where: { idempotencyKey: scopedIdempotencyKey },
      });
      if (!prior) {
        throw error;
      }
      transactionResult = {
        purchase: this.restorePrior(prior, requestFingerprint),
        created: false,
      };
    }

    if (transactionResult.created) {
      await this.realtime.safeBroadcastAll([
        () =>
          this.realtime.broadcastWalletBalanceChanged(userId, {
            reason: 'PURCHASE',
            delta: -product.price,
          }),
      ]);
    }
    return transactionResult.purchase;
  }

  private effectiveCapacity(
    configuredCapacity: number,
    membershipCapacity: number,
    expansionSeats: number,
  ): number {
    return Math.min(
      configuredCapacity,
      membershipCapacity + expansionSeats,
      GROUP_CAPACITY_HARD_LIMIT,
    );
  }

  private restorePrior(
    order: StoredExpansionOrder,
    requestFingerprint: string,
  ): GroupExpansionPurchaseResult {
    if (order.requestFingerprint !== requestFingerprint) {
      throw new ConflictException({
        message: 'Idempotency-Key 已用于其他扩容请求',
        errorCode: GroupExpansionErrorCode.IdempotencyConflict,
      });
    }
    return {
      orderId: order.id,
      circleId: order.circleID,
      productId: order.productID,
      productName: order.productName,
      seats: order.seats,
      price: order.price,
      previousMaxMembers: order.previousMaxMembers,
      newMaxMembers: order.newMaxMembers,
      walletBalanceAfter: order.walletBalanceAfter,
    };
  }
}
