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

// AdminAuditLog 与治理侧（moderation）共用一张表，列名沿用先落地的
// actorID / entityType / entityID；管理台对外讲的是 actor / target。两套名字
// 只在这一层来回转换，调用方和 HTTP 契约看到的始终是 target 语义。
const PUBLIC_AUDIT_SELECT = {
  id: true,
  actorID: true,
  actorAccountId: true,
  action: true,
  entityType: true,
  entityID: true,
  before: true,
  after: true,
  reason: true,
  metadata: true,
  requestId: true,
  ip: true,
  userAgent: true,
  createdAt: true,
} as const;

type AuditRow = Prisma.AdminAuditLogGetPayload<{
  select: typeof PUBLIC_AUDIT_SELECT;
}>;

function toAuditView(row: AuditRow) {
  const { actorID, actorAccountId, entityType, entityID, ...rest } = row;
  return {
    ...rest,
    actorId: actorID,
    // 治理侧不记账号，回落到 actorID，管理台列表不会出现空的操作人。
    actorAccountId: actorAccountId ?? actorID,
    targetType: entityType,
    targetId: entityID,
  };
}

@Injectable()
export class AdminUserAuditService {
  constructor(private readonly prisma: PrismaService) {}

  recordInTransaction(
    tx: Pick<Prisma.TransactionClient, 'adminAuditLog'>,
    input: AuditInput,
  ) {
    const context = getRequestContext();

    return tx.adminAuditLog.create({
      data: {
        actorID: input.actorId,
        actorAccountId: input.actorAccountId,
        action: input.action,
        entityType: input.targetType,
        entityID: input.targetId,
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

  async listForTarget(targetType: 'user', targetId: string, limit = 20) {
    const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));

    const rows = await this.prisma.adminAuditLog.findMany({
      where: { entityType: targetType, entityID: targetId },
      orderBy: { createdAt: 'desc' },
      take: boundedLimit,
      select: PUBLIC_AUDIT_SELECT,
    });

    return rows.map(toAuditView);
  }
}
