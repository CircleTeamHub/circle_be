import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { getRequestContext } from 'src/logging/request-context';
import { PrismaService } from 'src/prisma/prisma.service';

export type AuditInput = {
  actorId: string;
  actorAccountId: string;
  action: string;
  targetType: 'user';
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  metadata?: Record<string, unknown>;
};

const PUBLIC_AUDIT_SELECT = {
  id: true,
  actorId: true,
  actorAccountId: true,
  action: true,
  targetType: true,
  targetId: true,
  before: true,
  after: true,
  reason: true,
  metadata: true,
  requestId: true,
  ip: true,
  userAgent: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  recordInTransaction(
    tx: Pick<Prisma.TransactionClient, 'adminAuditLog'>,
    input: AuditInput,
  ) {
    const context = getRequestContext();

    return tx.adminAuditLog.create({
      data: {
        actorId: input.actorId,
        actorAccountId: input.actorAccountId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        before: input.before as Prisma.InputJsonValue,
        after: input.after as Prisma.InputJsonValue,
        reason: input.reason,
        metadata: input.metadata as Prisma.InputJsonValue,
        requestId: context?.requestId,
        ip: context?.ip?.slice(0, 64),
        userAgent: context?.userAgent?.slice(0, 256),
      },
    });
  }

  listForTarget(targetType: 'user', targetId: string, limit = 20) {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));

    return this.prisma.adminAuditLog.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: 'desc' },
      take: boundedLimit,
      select: PUBLIC_AUDIT_SELECT,
    });
  }
}
