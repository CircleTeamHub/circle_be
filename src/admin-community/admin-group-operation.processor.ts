import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AdminGroupOperation } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';

const PROCESS_INTERVAL_MS = 5_000;
const STALE_CLAIM_MS = 5 * 60_000;

@Injectable()
export class AdminGroupOperationProcessor {
  private readonly logger = new Logger(AdminGroupOperationProcessor.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  private async dismissChatConversation(circleId: string): Promise<void> {
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { circleID: circleId },
      select: { id: true },
    });
    if (!conversation) return;
    await this.prisma.chatMember.updateMany({
      where: { conversationID: conversation.id, leftAt: null },
      data: { leftAt: new Date() },
    });
  }

  /** 自研会话侧禁言开关(groupID === circle.id;会话未建时为 no-op,建时对账兜底)。 */
  private async setChatMuteAll(
    circleId: string,
    muted: boolean,
  ): Promise<void> {
    await this.prisma.chatConversation.updateMany({
      where: { circleID: circleId },
      data: { muteAllAt: muted ? new Date() : null },
    });
  }

  @Interval(PROCESS_INTERVAL_MS)
  async processAvailable(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverStaleClaims(new Date());
      for (let index = 0; index < 10; index += 1) {
        if (!(await this.processOne(new Date()))) break;
      }
    } finally {
      this.running = false;
    }
  }

  async processOne(now: Date): Promise<boolean> {
    const candidate = await this.prisma.adminGroupOperation.findFirst({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (!candidate) return false;
    const claimed = await this.prisma.adminGroupOperation.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        claimedAt: now,
      },
    });
    if (claimed.count !== 1) return true;
    const operation = await this.prisma.adminGroupOperation.findUnique({
      where: { id: candidate.id },
    });
    if (!operation) return true;

    try {
      await this.execute(operation);
      await this.complete(operation, now);
    } catch (error) {
      if (operation.type === 'DISMISS' && this.isAlreadyAbsentGroup(error)) {
        await this.complete(operation, now);
      } else {
        await this.fail(operation, error, now);
      }
    }
    return true;
  }

  private async execute(operation: AdminGroupOperation) {
    if (operation.type === 'MUTE') {
      return this.setChatMuteAll(operation.groupID, true);
    }
    if (operation.type === 'UNMUTE') {
      return this.setChatMuteAll(operation.groupID, false);
    }
    // 解散:会话全员离座(历史保留;发送被 membership 校验拒绝)。
    return this.dismissChatConversation(operation.groupID);
  }

  private complete(operation: AdminGroupOperation, now: Date) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const completed = await tx.adminGroupOperation.updateMany({
        where: {
          id: operation.id,
          status: 'PROCESSING',
          claimedAt: now,
        },
        data: {
          status: 'SUCCEEDED',
          completedAt: now,
          claimedAt: null,
          lastError: null,
        },
      });
      if (completed.count !== 1) return;
      if (operation.circleID) {
        await tx.circle.update({
          where: { id: operation.circleID },
          data: this.completedCircleState(operation.type),
        });
      }
      await tx.adminAuditLog.create({
        data: {
          actorID: operation.requestedByID,
          action: 'ADMIN_GROUP_OPERATION_SUCCEEDED',
          entityType: operation.circleID ? 'Circle' : 'OpenIMGroup',
          entityID: operation.circleID ?? operation.groupID,
          after: {
            operationId: operation.id,
            groupID: operation.groupID,
            type: operation.type,
            status: 'SUCCEEDED',
          },
        },
      });
    });
  }

  private fail(operation: AdminGroupOperation, error: unknown, now: Date) {
    const message = this.errorMessage(error);
    const finalAttempt = operation.attempts >= operation.maxAttempts;
    const delayMs = Math.min(5 * 60_000, 2 ** operation.attempts * 1_000);
    this.logger.warn(
      `Admin group operation ${operation.id} failed on attempt ${operation.attempts}: ${message}`,
    );
    return runSerializableTransaction(this.prisma, async (tx) => {
      const failed = await tx.adminGroupOperation.updateMany({
        where: {
          id: operation.id,
          status: 'PROCESSING',
          claimedAt: now,
        },
        data: finalAttempt
          ? {
              status: 'FAILED',
              completedAt: now,
              claimedAt: null,
              lastError: message,
            }
          : {
              status: 'PENDING',
              nextAttemptAt: new Date(now.getTime() + delayMs),
              claimedAt: null,
              lastError: message,
            },
      });
      if (failed.count !== 1) return;
      if (finalAttempt && operation.circleID) {
        await tx.circle.update({
          where: { id: operation.circleID },
          data: { adminState: 'SYNC_FAILED' },
        });
      }
      if (finalAttempt) {
        await tx.adminAuditLog.create({
          data: {
            actorID: operation.requestedByID,
            action: 'ADMIN_GROUP_OPERATION_FAILED',
            entityType: operation.circleID ? 'Circle' : 'OpenIMGroup',
            entityID: operation.circleID ?? operation.groupID,
            after: {
              operationId: operation.id,
              groupID: operation.groupID,
              type: operation.type,
              status: 'FAILED',
              attempts: operation.attempts,
            },
            reason: message,
          },
        });
      }
    });
  }

  private recoverStaleClaims(now: Date) {
    return this.prisma.adminGroupOperation.updateMany({
      where: {
        status: 'PROCESSING',
        claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
      },
      data: { status: 'PENDING', claimedAt: null, nextAttemptAt: now },
    });
  }

  private isAlreadyAbsentGroup(error: unknown) {
    return /RecordNotFoundError|group.*not.*found|already dismissed/i.test(
      this.errorMessage(error),
    );
  }

  private completedCircleState(type: AdminGroupOperation['type']) {
    if (type === 'UNMUTE') {
      return {
        deleted: false,
        adminState: 'ACTIVE' as const,
        adminDisabledAt: null,
        adminDisabledBy: null,
        adminDisableReason: null,
      };
    }
    if (type === 'DISMISS') {
      return { deleted: true, adminState: 'DISMISSED' as const };
    }
    return { adminState: 'DISABLED' as const };
  }

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 1_000);
  }
}
