import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminGroupOperationType,
  CircleAdminState,
  Prisma,
} from 'src/generated/prisma';
import {
  type OpenimAdminGroup,
  OpenimService,
} from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';

type CircleAction = {
  actorId: string;
  circleId: string;
  reason: string;
  confirmation: string;
  idempotencyKey: string;
};

type GroupAction = {
  actorId: string;
  groupId: string;
  type: AdminGroupOperationType;
  reason: string;
  confirmation: string;
  idempotencyKey: string;
};

@Injectable()
export class AdminCommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openim: OpenimService,
  ) {}

  async listCircles(query: {
    page: number;
    limit: number;
    search?: string;
    status?: CircleAdminState;
  }) {
    const search = query.search?.trim();
    const where: Prisma.CircleWhereInput = {
      ...(query.status ? { adminState: query.status } : {}),
      ...(search
        ? {
            OR: [
              { id: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { groupID: { contains: search, mode: 'insensitive' } },
              {
                owner: {
                  is: {
                    OR: [
                      {
                        accountId: {
                          contains: search,
                          mode: 'insensitive',
                        },
                      },
                      {
                        nickname: {
                          contains: search,
                          mode: 'insensitive',
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [total, circles] = await Promise.all([
      this.prisma.circle.count({ where }),
      this.prisma.circle.findMany({
        where,
        select: {
          id: true,
          name: true,
          groupID: true,
          memberCount: true,
          postCount: true,
          deleted: true,
          adminState: true,
          adminDisabledAt: true,
          adminDisabledBy: true,
          adminDisableReason: true,
          createdAt: true,
          owner: {
            select: { id: true, accountId: true, nickname: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    const operations = await this.latestOperations(
      circles.flatMap((circle) => (circle.groupID ? [circle.groupID] : [])),
    );
    return {
      items: circles.map((circle) => ({
        ...circle,
        latestOperation: circle.groupID
          ? (operations.get(circle.groupID) ?? null)
          : null,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async listGroups(query: { page: number; limit: number; search?: string }) {
    const response = await this.openim.listGroups({
      page: query.page,
      limit: query.limit,
      keyword: query.search,
    });
    const groupIds = response.groups.map((group) => group.groupInfo.groupID);
    const [circles, operations] = await Promise.all([
      this.prisma.circle.findMany({
        where: { groupID: { in: groupIds } },
        select: { id: true, name: true, groupID: true },
      }),
      this.latestOperations(groupIds),
    ]);
    const circlesByGroup = new Map(
      circles
        .filter((circle) => circle.groupID)
        .map((circle) => [
          circle.groupID as string,
          { id: circle.id, name: circle.name },
        ]),
    );
    return {
      items: response.groups.map((group) =>
        this.mapGroup(
          group,
          circlesByGroup.get(group.groupInfo.groupID) ?? null,
          operations.get(group.groupInfo.groupID) ?? null,
        ),
      ),
      total: response.total,
      page: query.page,
      limit: query.limit,
    };
  }

  disableCircle(input: CircleAction) {
    return this.queueCircleOperation(input, 'MUTE');
  }

  restoreCircle(input: CircleAction) {
    return this.queueCircleOperation(input, 'UNMUTE');
  }

  async requestGroupOperation(input: GroupAction) {
    const groupID = this.normalizeGroupId(input.groupId);
    if (input.confirmation !== groupID) {
      throw new ConflictException('确认群 ID 不匹配');
    }
    try {
      return await runSerializableTransaction(this.prisma, async (tx) => {
        await this.lockGroup(tx, groupID);
        const linkedCircle =
          input.type === 'DISMISS'
            ? await tx.circle.findFirst({
                where: { groupID },
                select: {
                  id: true,
                  name: true,
                  deleted: true,
                  adminState: true,
                },
              })
            : null;
        const duplicate = await tx.adminGroupOperation.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (duplicate) {
          this.assertSameOperation(duplicate, {
            actorId: input.actorId,
            groupID,
            circleID: linkedCircle?.id ?? null,
            type: input.type,
            reason: input.reason,
          });
          return duplicate;
        }
        await this.assertNoActiveOperation(tx, groupID);
        if (linkedCircle) {
          await tx.circle.update({
            where: { id: linkedCircle.id },
            data: {
              deleted: true,
              adminState: 'DISABLING',
              adminDisabledAt: new Date(),
              adminDisabledBy: input.actorId,
              adminDisableReason: input.reason,
            },
          });
        }
        const operation = await tx.adminGroupOperation.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            groupID,
            circleID: linkedCircle?.id ?? null,
            type: input.type,
            requestedByID: input.actorId,
            reason: input.reason,
          },
        });
        await this.auditQueued(tx, operation, input.actorId);
        return operation;
      });
    } catch (error) {
      this.rethrowOperationConflict(error);
    }
  }

  async getOperation(id: string) {
    const operation = await this.prisma.adminGroupOperation.findUnique({
      where: { id },
    });
    if (!operation) throw new NotFoundException('管理操作不存在');
    return operation;
  }

  private async queueCircleOperation(
    input: CircleAction,
    type: 'MUTE' | 'UNMUTE',
  ) {
    try {
      return await runSerializableTransaction(this.prisma, async (tx) => {
        const circle = await tx.circle.findUnique({
          where: { id: input.circleId },
          select: {
            id: true,
            name: true,
            groupID: true,
            deleted: true,
            adminState: true,
            adminDisabledAt: true,
            adminDisabledBy: true,
            adminDisableReason: true,
          },
        });
        if (!circle) throw new NotFoundException('圈子不存在');
        if (
          input.confirmation !== circle.name &&
          input.confirmation !== circle.id
        ) {
          throw new ConflictException('确认圈子名称不匹配');
        }
        if (!circle.groupID) {
          return this.applyLocalCircleOperation(tx, circle, input, type);
        }
        await this.lockGroup(tx, circle.groupID);
        const duplicate = await tx.adminGroupOperation.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (duplicate) {
          this.assertSameOperation(duplicate, {
            actorId: input.actorId,
            groupID: circle.groupID,
            circleID: circle.id,
            type,
            reason: input.reason,
          });
          return { circle, operation: duplicate };
        }
        await this.assertNoActiveOperation(tx, circle.groupID);

        if (type === 'MUTE' && circle.adminState === 'DISABLED') {
          throw new ConflictException('圈子已经停用');
        }
        if (type === 'UNMUTE' && circle.adminState === 'DISMISSED') {
          throw new ConflictException('群聊已永久解散，圈子不可恢复');
        }
        if (type === 'UNMUTE' && !circle.deleted) {
          throw new ConflictException('圈子当前未停用');
        }
        if (type === 'UNMUTE' && !this.hasAdminDisableProvenance(circle)) {
          throw new ConflictException('圈子不是由管理员停用，无法恢复');
        }
        const updatedCircle = await tx.circle.update({
          where: { id: circle.id },
          data:
            type === 'MUTE'
              ? {
                  deleted: true,
                  adminState: 'DISABLING',
                  adminDisabledAt: new Date(),
                  adminDisabledBy: input.actorId,
                  adminDisableReason: input.reason,
                }
              : { adminState: 'RESTORING' },
        });
        const operation = await tx.adminGroupOperation.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            groupID: circle.groupID,
            circleID: circle.id,
            type,
            requestedByID: input.actorId,
            reason: input.reason,
          },
        });
        await this.auditQueued(tx, operation, input.actorId);
        return { circle: updatedCircle, operation };
      });
    } catch (error) {
      this.rethrowOperationConflict(error);
    }
  }

  private async applyLocalCircleOperation(
    tx: Prisma.TransactionClient,
    circle: {
      id: string;
      name: string;
      groupID: string | null;
      deleted: boolean;
      adminState: CircleAdminState;
      adminDisabledAt: Date | null;
      adminDisabledBy: string | null;
      adminDisableReason: string | null;
    },
    input: CircleAction,
    type: 'MUTE' | 'UNMUTE',
  ) {
    await this.lockGroup(tx, `circle:${circle.id}`);
    await this.lockGroup(tx, `idempotency:${input.idempotencyKey}`);
    const duplicate = await tx.adminAuditLog.findFirst({
      where: {
        requestId: input.idempotencyKey,
        action: 'ADMIN_CIRCLE_STATE_CHANGED',
      },
      select: {
        actorID: true,
        entityID: true,
        reason: true,
        metadata: true,
      },
    });
    if (duplicate) {
      const metadata =
        duplicate.metadata &&
        typeof duplicate.metadata === 'object' &&
        !Array.isArray(duplicate.metadata)
          ? (duplicate.metadata as Record<string, unknown>)
          : null;
      if (
        duplicate.actorID !== input.actorId ||
        duplicate.entityID !== circle.id ||
        duplicate.reason !== input.reason ||
        metadata?.type !== type
      ) {
        throw new ConflictException('Idempotency-Key 已用于其他管理操作');
      }
      return { circle, operation: null };
    }

    if (type === 'MUTE' && circle.adminState === 'DISABLED') {
      throw new ConflictException('圈子已经停用');
    }
    if (type === 'UNMUTE' && !circle.deleted) {
      throw new ConflictException('圈子当前未停用');
    }
    if (type === 'UNMUTE' && !this.hasAdminDisableProvenance(circle)) {
      throw new ConflictException('圈子不是由管理员停用，无法恢复');
    }

    const updatedCircle = await tx.circle.update({
      where: { id: circle.id },
      data:
        type === 'MUTE'
          ? {
              deleted: true,
              adminState: 'DISABLED',
              adminDisabledAt: new Date(),
              adminDisabledBy: input.actorId,
              adminDisableReason: input.reason,
            }
          : {
              deleted: false,
              adminState: 'ACTIVE',
              adminDisabledAt: null,
              adminDisabledBy: null,
              adminDisableReason: null,
            },
    });
    await tx.adminAuditLog.create({
      data: {
        actorID: input.actorId,
        action: 'ADMIN_CIRCLE_STATE_CHANGED',
        entityType: 'Circle',
        entityID: circle.id,
        before: {
          deleted: circle.deleted,
          adminState: circle.adminState,
        },
        after: {
          deleted: type === 'MUTE',
          adminState: type === 'MUTE' ? 'DISABLED' : 'ACTIVE',
        },
        reason: input.reason,
        metadata: { type, synchronization: 'LOCAL_ONLY' },
        requestId: input.idempotencyKey,
      },
    });
    return { circle: updatedCircle, operation: null };
  }

  private hasAdminDisableProvenance(circle: {
    adminState: CircleAdminState;
    adminDisabledAt: Date | null;
    adminDisabledBy: string | null;
    adminDisableReason: string | null;
  }) {
    return (
      (circle.adminState === 'DISABLED' ||
        circle.adminState === 'SYNC_FAILED') &&
      circle.adminDisabledAt instanceof Date &&
      typeof circle.adminDisabledBy === 'string' &&
      circle.adminDisabledBy.length > 0 &&
      typeof circle.adminDisableReason === 'string' &&
      circle.adminDisableReason.length > 0
    );
  }

  private latestOperations(groupIds: string[]) {
    if (groupIds.length === 0) {
      return Promise.resolve(new Map<string, never>());
    }
    return this.prisma.adminGroupOperation
      .findMany({
        where: { groupID: { in: groupIds } },
        distinct: ['groupID'],
        orderBy: [{ groupID: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          groupID: true,
          type: true,
          status: true,
          lastError: true,
          createdAt: true,
        },
      })
      .then((rows) => {
        const result = new Map<string, (typeof rows)[number]>();
        rows.forEach((row) => {
          if (!result.has(row.groupID)) result.set(row.groupID, row);
        });
        return result;
      });
  }

  private mapGroup(
    group: OpenimAdminGroup,
    linkedCircle: { id: string; name: string } | null,
    pendingOperation: {
      id: string;
      type: AdminGroupOperationType;
      status: string;
      lastError: string | null;
    } | null,
  ) {
    return {
      groupId: group.groupInfo.groupID,
      name: group.groupInfo.groupName,
      faceUrl: group.groupInfo.faceURL ?? null,
      status: group.groupInfo.status,
      muted: group.groupInfo.status === 3,
      memberCount: group.groupInfo.memberCount ?? 0,
      ownerUserId: group.groupOwnerUserID ?? null,
      ownerName: group.groupOwnerUserName ?? null,
      linkedCircle,
      pendingOperation,
    };
  }

  private async assertNoActiveOperation(
    tx: Prisma.TransactionClient,
    groupID: string,
  ) {
    const active = await tx.adminGroupOperation.findFirst({
      where: {
        groupID,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      select: { id: true },
    });
    if (active) {
      throw new ConflictException('该群聊已有管理操作正在处理中');
    }
  }

  private lockGroup(tx: Prisma.TransactionClient, groupID: string) {
    const lockKey = `admin-community:${groupID}`;
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  }

  private auditQueued(
    tx: Prisma.TransactionClient,
    operation: {
      id: string;
      groupID: string;
      circleID: string | null;
      type: AdminGroupOperationType;
    },
    actorId: string,
  ) {
    return tx.adminAuditLog.create({
      data: {
        actorID: actorId,
        action: 'ADMIN_GROUP_OPERATION_QUEUED',
        entityType: operation.circleID ? 'Circle' : 'OpenIMGroup',
        entityID: operation.circleID ?? operation.groupID,
        after: {
          operationId: operation.id,
          groupID: operation.groupID,
          type: operation.type,
          status: 'PENDING',
        },
      },
    });
  }

  private normalizeGroupId(value: string) {
    const groupID = value.trim();
    if (!groupID || groupID.length > 128) {
      throw new NotFoundException('群聊不存在');
    }
    return groupID;
  }

  private assertSameOperation(
    operation: {
      requestedByID: string;
      groupID: string;
      circleID: string | null;
      type: AdminGroupOperationType;
      reason: string;
    },
    expected: {
      actorId: string;
      groupID: string;
      circleID: string | null;
      type: AdminGroupOperationType;
      reason: string;
    },
  ) {
    if (
      operation.requestedByID !== expected.actorId ||
      operation.groupID !== expected.groupID ||
      operation.circleID !== expected.circleID ||
      operation.type !== expected.type ||
      operation.reason !== expected.reason
    ) {
      throw new ConflictException('Idempotency-Key 已用于其他管理操作');
    }
  }

  private rethrowOperationConflict(error: unknown): never {
    if (prismaErrorCode(error) === 'P2002') {
      throw new ConflictException('该群聊已有管理操作正在处理中');
    }
    throw error;
  }
}
