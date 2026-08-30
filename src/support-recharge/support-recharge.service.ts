import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminUserAuditService } from 'src/admin-user/admin-user-audit.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import { CoinService } from 'src/coin/coin.service';
import { SupportErrorCode } from 'src/common/app-error-codes';
import {
  Prisma,
  SupportRechargeFulfillmentType,
  SupportRechargeOrder,
} from 'src/generated/prisma';
import { MembershipAdminService } from 'src/membership/membership-admin.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { UploadService } from 'src/upload/upload.service';
import { prismaErrorCode } from 'src/utils/prisma-tx';
import {
  ApproveSupportRechargeOrderDto,
  CreateSupportRechargePaymentCodeDto,
  ListSupportRechargeOrdersQueryDto,
} from './support-recharge.dto';

type Operator = { userId: string; accountId: string };

type SupportedFulfillmentType = Extract<
  SupportRechargeFulfillmentType,
  'COIN' | 'MEMBERSHIP'
>;

type CanonicalFulfillment = {
  fulfillmentType: SupportedFulfillmentType;
  paymentTransactionId: string;
  coinAmount?: number;
  membershipLevel?: number;
  note: string | null;
};

const ORDER_SELECT = {
  id: true,
  orderNo: true,
  conversationID: true,
  userID: true,
  agentUserID: true,
  requestKind: true,
  status: true,
  evidenceMessageID: true,
  evidenceObjectKey: true,
  submittedAt: true,
  fulfillmentType: true,
  fulfillmentPayload: true,
  paymentTransactionID: true,
  reviewedBy: true,
  reviewedAt: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class SupportRechargeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminUserAuditService,
    private readonly upload: UploadService,
    private readonly messages: ChatSystemMessageService,
    private readonly coins: CoinService,
    private readonly memberships: MembershipAdminService,
    private readonly realtime: RealtimeService,
  ) {}

  async listPaymentCodes() {
    const rows = await this.prisma.supportRechargePaymentCode.findMany({
      orderBy: [
        { enabled: 'desc' },
        { validFrom: 'desc' },
        { createdAt: 'desc' },
      ],
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        previewUrl: await this.signEvidence(row.objectKey),
      })),
    );
  }

  async createPaymentCode(
    operator: Operator,
    dto: CreateSupportRechargePaymentCodeDto,
  ) {
    const validFrom = new Date(dto.validFrom);
    const validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    if (validUntil && validUntil <= validFrom) {
      throw new BadRequestException({
        message: '收款码失效时间必须晚于生效时间',
        errorCode: SupportErrorCode.RechargePaymentCodeInvalid,
      });
    }
    // 普通上传接口只允许签出 chat/{当前用户}/...。创建配置时再绑一次当前
    // 管理员，避免拿一个从聊天历史里看到的别人 object key 变成全局收款码。
    if (!dto.objectKey.startsWith(`chat/${operator.userId}/`)) {
      throw new BadRequestException({
        message: '收款码图片必须由当前管理员上传',
        errorCode: SupportErrorCode.RechargePaymentCodeInvalid,
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.supportRechargePaymentCode.create({
        data: {
          label: dto.label,
          objectKey: dto.objectKey,
          validFrom,
          validUntil,
          createdBy: operator.userId,
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: operator.userId,
        actorAccountId: operator.accountId,
        action: 'support.recharge.payment_code.create',
        targetType: 'support_recharge_payment_code',
        targetId: row.id,
        after: this.paymentCodeAudit(row),
      });
      return row;
    });
    return {
      ...created,
      previewUrl: await this.signEvidence(created.objectKey),
    };
  }

  async setPaymentCodeEnabled(
    operator: Operator,
    id: string,
    enabled: boolean,
  ) {
    const after = await this.prisma.$transaction(async (tx) => {
      const before = await tx.supportRechargePaymentCode.findUnique({
        where: { id },
      });
      if (!before) {
        throw new NotFoundException({
          message: '收款码不存在',
          errorCode: SupportErrorCode.RechargePaymentCodeNotFound,
        });
      }
      const after = await tx.supportRechargePaymentCode.update({
        where: { id },
        data: { enabled },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: operator.userId,
        actorAccountId: operator.accountId,
        action: 'support.recharge.payment_code.set_enabled',
        targetType: 'support_recharge_payment_code',
        targetId: id,
        before: this.paymentCodeAudit(before),
        after: this.paymentCodeAudit(after),
      });
      return after;
    });
    return { ...after, previewUrl: await this.signEvidence(after.objectKey) };
  }

  async listOrders(query: ListSupportRechargeOrdersQueryDto) {
    const orders = await this.prisma.supportRechargeOrder.findMany({
      where: query.status ? { status: query.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: ORDER_SELECT,
    });
    return this.presentOrders(orders);
  }

  private async presentOrders(
    orders: Array<
      Prisma.SupportRechargeOrderGetPayload<{
        select: typeof ORDER_SELECT;
      }>
    >,
  ) {
    const userIds = [
      ...new Set(orders.flatMap((order) => [order.userID, order.agentUserID])),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, accountId: true, nickname: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    return Promise.all(
      orders.map(async (order) => {
        const { evidenceObjectKey, ...safeOrder } = order;
        return {
          ...safeOrder,
          user: byId.get(order.userID) ?? null,
          agent: byId.get(order.agentUserID) ?? null,
          evidenceUrl: evidenceObjectKey
            ? await this.signEvidence(evidenceObjectKey)
            : null,
        };
      }),
    );
  }

  async approveOrder(
    operator: Operator,
    orderId: string,
    dto: ApproveSupportRechargeOrderDto,
  ) {
    const input = this.canonicalizeFulfillment(dto);
    await this.validateFulfillmentTarget(orderId, input);
    let order = await this.claimApproval(operator, orderId, input);

    if (order.status !== 'APPROVED') {
      if (input.fulfillmentType === 'COIN') {
        await this.fulfillCoins(operator, order, input);
        this.realtime.broadcastWalletRechargeCompleted(
          order.userID,
          input.coinAmount!,
        );
      } else {
        await this.memberships.grant(order.reviewedBy!, order.userID, {
          targetLevel: input.membershipLevel!,
          idempotencyKey: order.id,
          note: input.note ?? `充值申请 ${order.orderNo}`,
        });
        await this.finalizeApproval(operator, order.id);
      }
      order = await this.requireOrder(order.id);
    }

    await this.sendApprovalReceipt(order, input);
    const selected = await this.prisma.supportRechargeOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: ORDER_SELECT,
    });
    return (await this.presentOrders([selected]))[0];
  }

  async rejectOrder(operator: Operator, orderId: string, reason: string) {
    const order = await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const before = await tx.supportRechargeOrder.findUnique({
        where: { id: orderId },
      });
      if (!before) this.orderNotFound();
      if (before.status === 'APPROVED' || before.status === 'PROCESSING') {
        this.orderStateConflict('已开始或已经完成发放，不能驳回');
      }
      if (before.status === 'REJECTED') return before;
      const after = await tx.supportRechargeOrder.update({
        where: { id: orderId },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          reviewedBy: operator.userId,
          reviewedAt: new Date(),
        },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: operator.userId,
        actorAccountId: operator.accountId,
        action: 'support.recharge.order.reject',
        targetType: 'support_recharge_order',
        targetId: after.id,
        before: this.orderAudit(before),
        after: this.orderAudit(after),
        reason,
      });
      await tx.supportRechargeConversationState.updateMany({
        where: { conversationID: after.conversationID },
        data: { mode: 'BOT' },
      });
      return after;
    });
    await this.messages.insertServerMessage(order.conversationID, {
      senderID: order.agentUserID,
      type: 'text',
      content: {
        text:
          `充值申请 ${order.orderNo} 暂未通过核对：${reason}。` +
          '请检查付款记录后继续留言，客服会协助你处理。',
      },
      clientMessageId: `sr-${order.id}-rejected`,
      push: true,
    });
    return order;
  }

  private canonicalizeFulfillment(
    dto: ApproveSupportRechargeOrderDto,
  ): CanonicalFulfillment {
    let benefit: Pick<
      CanonicalFulfillment,
      'coinAmount' | 'membershipLevel'
    > = {};
    if (dto.fulfillmentType === 'COIN') {
      benefit = { coinAmount: dto.coinAmount! };
    } else {
      benefit = { membershipLevel: dto.membershipLevel! };
    }
    return {
      fulfillmentType: dto.fulfillmentType,
      paymentTransactionId: dto.paymentTransactionId,
      ...benefit,
      note: dto.note?.trim() || null,
    };
  }

  private async validateFulfillmentTarget(
    orderId: string,
    input: CanonicalFulfillment,
  ): Promise<void> {
    const order = await this.requireOrder(orderId);
    // PROCESSING/APPROVED 是同一管理员动作的恢复路径。权益可能已经由下游服务
    // 提交、只差本单 finalize；此时再拿“当前会员等级/资产启用状态”做首次校验，
    // 会把一个本可幂等收敛的半成功订单永久卡住。
    if (order.status === 'PROCESSING' || order.status === 'APPROVED') {
      this.assertSameApproval(order, input);
      return;
    }
    const target = await this.prisma.user.findUnique({
      where: { id: order.userID },
      select: { status: true, vipLevel: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new ConflictException({
        message: '目标用户当前不可发放权益',
        errorCode: SupportErrorCode.RechargeApprovalConflict,
      });
    }
    if (
      input.fulfillmentType === 'MEMBERSHIP' &&
      input.membershipLevel! <= target.vipLevel
    ) {
      throw new ConflictException({
        message: '会员等级必须高于用户当前等级',
        errorCode: SupportErrorCode.RechargeApprovalConflict,
      });
    }
  }

  private async claimApproval(
    operator: Operator,
    orderId: string,
    input: CanonicalFulfillment,
  ): Promise<SupportRechargeOrder> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockOrder(tx, orderId);
        const current = await tx.supportRechargeOrder.findUnique({
          where: { id: orderId },
        });
        if (!current) this.orderNotFound();
        if (current.status === 'REJECTED') {
          this.orderStateConflict('已驳回的申请不能发放');
        }
        if (current.status === 'AWAITING_PROOF') {
          this.orderStateConflict('用户尚未提交付款记录');
        }
        if (current.status === 'PROCESSING' || current.status === 'APPROVED') {
          this.assertSameApproval(current, input);
          return current;
        }

        const duplicatePayment = await tx.supportRechargeOrder.findFirst({
          where: {
            paymentTransactionID: input.paymentTransactionId,
            id: { not: orderId },
          },
          select: { id: true },
        });
        if (duplicatePayment) {
          throw new ConflictException({
            message: '该支付交易号已经处理过',
            errorCode: SupportErrorCode.RechargePaymentDuplicate,
          });
        }
        return tx.supportRechargeOrder.update({
          where: { id: orderId },
          data: {
            status: 'PROCESSING',
            fulfillmentType: input.fulfillmentType,
            fulfillmentPayload: input as unknown as Prisma.InputJsonObject,
            paymentTransactionID: input.paymentTransactionId,
            reviewedBy: operator.userId,
          },
        });
      });
    } catch (error) {
      // 两张不同申请可并发通过各自的行锁；paymentTransactionID 的唯一索引是
      // 防止同一笔支付被重复发放的最终边界。把竞态输家映射成业务冲突，而不是
      // 让管理员只看到一个无从处理的通用数据库错误。
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: '该支付交易号已经处理过',
          errorCode: SupportErrorCode.RechargePaymentDuplicate,
        });
      }
      throw error;
    }
  }

  private async fulfillCoins(
    operator: Operator,
    order: SupportRechargeOrder,
    input: CanonicalFulfillment,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, order.id);
      const current = await tx.supportRechargeOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      if (current.status === 'APPROVED') return;
      this.assertSameApproval(current, input);
      const replay = await tx.coinTransaction.findUnique({
        where: { idempotencyKey: order.id },
      });
      if (replay) {
        if (
          replay.userID !== order.userID ||
          replay.type !== 'RECHARGE' ||
          replay.amount !== input.coinAmount
        ) {
          throw new ConflictException({
            message: '充值申请的积分幂等键已被不同参数使用',
            errorCode: SupportErrorCode.RechargeApprovalConflict,
          });
        }
      } else {
        await this.coins.creditInTransaction(tx, {
          userId: order.userID,
          amount: input.coinAmount!,
          type: 'RECHARGE',
          note: input.note ?? `充值申请 ${order.orderNo}`,
          relatedId: order.id,
          idempotencyKey: order.id,
        });
      }
      const approved = await tx.supportRechargeOrder.update({
        where: { id: order.id },
        data: { status: 'APPROVED', reviewedAt: new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: operator.userId,
        actorAccountId: operator.accountId,
        action: 'support.recharge.order.approve',
        targetType: 'support_recharge_order',
        targetId: approved.id,
        before: this.orderAudit(current),
        after: this.orderAudit(approved),
        metadata: { fulfillmentType: 'COIN' },
      });
      await tx.supportRechargeConversationState.updateMany({
        where: { conversationID: order.conversationID },
        data: { mode: 'BOT' },
      });
    });
  }

  private async finalizeApproval(operator: Operator, orderId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const current = await tx.supportRechargeOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      if (current.status === 'APPROVED') return;
      if (current.status !== 'PROCESSING') {
        this.orderStateConflict('充值申请不在发放处理中');
      }
      const approved = await tx.supportRechargeOrder.update({
        where: { id: orderId },
        data: { status: 'APPROVED', reviewedAt: new Date() },
      });
      await this.audit.recordInTransaction(tx, {
        actorId: operator.userId,
        actorAccountId: operator.accountId,
        action: 'support.recharge.order.approve',
        targetType: 'support_recharge_order',
        targetId: approved.id,
        before: this.orderAudit(current),
        after: this.orderAudit(approved),
        metadata: { fulfillmentType: approved.fulfillmentType },
      });
      await tx.supportRechargeConversationState.updateMany({
        where: { conversationID: approved.conversationID },
        data: { mode: 'BOT' },
      });
    });
  }

  private async sendApprovalReceipt(
    order: SupportRechargeOrder,
    input: CanonicalFulfillment,
  ): Promise<void> {
    let result: string;
    if (input.fulfillmentType === 'COIN') {
      result = `已发放积分：${input.coinAmount}`;
    } else {
      result = `会员已开通：Lv.${input.membershipLevel}`;
    }
    await this.messages.insertServerMessage(order.conversationID, {
      senderID: order.agentUserID,
      type: 'text',
      content: {
        text:
          `充值申请 ${order.orderNo} 已核对完成。${result}。` +
          '你可以前往对应页面查看；如果结果与预期不一致，请继续在这里留言。',
      },
      clientMessageId: `sr-${order.id}-approved`,
      push: true,
    });
  }

  private assertSameApproval(
    order: SupportRechargeOrder,
    input: CanonicalFulfillment,
  ): void {
    const stored = order.fulfillmentPayload;
    const payload =
      stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : null;
    if (
      order.fulfillmentType !== input.fulfillmentType ||
      order.paymentTransactionID !== input.paymentTransactionId ||
      payload?.fulfillmentType !== input.fulfillmentType ||
      payload.paymentTransactionId !== input.paymentTransactionId ||
      (payload.note ?? null) !== input.note ||
      (input.fulfillmentType === 'COIN' &&
        payload.coinAmount !== input.coinAmount) ||
      (input.fulfillmentType === 'MEMBERSHIP' &&
        payload.membershipLevel !== input.membershipLevel)
    ) {
      throw new ConflictException({
        message: '该充值申请已经使用不同的发放参数处理',
        errorCode: SupportErrorCode.RechargeApprovalConflict,
      });
    }
  }

  private async lockOrder(tx: Prisma.TransactionClient, orderId: string) {
    await tx.$queryRaw`
      SELECT "id" FROM "SupportRechargeOrder"
      WHERE "id" = ${orderId} FOR UPDATE`;
  }

  private async requireOrder(orderId: string): Promise<SupportRechargeOrder> {
    const order = await this.prisma.supportRechargeOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) this.orderNotFound();
    return order;
  }

  private orderNotFound(): never {
    throw new NotFoundException({
      message: '充值申请不存在',
      errorCode: SupportErrorCode.RechargeOrderNotFound,
    });
  }

  private orderStateConflict(message: string): never {
    throw new ConflictException({
      message,
      errorCode: SupportErrorCode.RechargeOrderStateConflict,
    });
  }

  private async signEvidence(objectKey: string): Promise<string | null> {
    try {
      return (await this.upload.createPresignedGetUrl(objectKey, 15 * 60)).url;
    } catch {
      return null;
    }
  }

  private paymentCodeAudit(row: {
    id: string;
    label: string;
    objectKey: string;
    validFrom: Date;
    validUntil: Date | null;
    enabled: boolean;
  }) {
    return {
      id: row.id,
      label: row.label,
      // object key 不进审计快照；管理员只需要知道是哪一条配置，不需要让私有
      // 媒体定位符长期复制到另一张表。
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil?.toISOString() ?? null,
      enabled: row.enabled,
    };
  }

  private orderAudit(order: SupportRechargeOrder) {
    return {
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      requestKind: order.requestKind,
      fulfillmentType: order.fulfillmentType,
      paymentTransactionID: order.paymentTransactionID,
      reviewedBy: order.reviewedBy,
      reviewedAt: order.reviewedAt?.toISOString() ?? null,
      rejectionReason: order.rejectionReason,
    };
  }
}
