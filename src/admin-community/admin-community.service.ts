import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminGroupOperation,
  AdminGroupOperationType,
  Circle,
  CircleAdminState,
  Prisma,
} from 'src/generated/prisma';
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

/**
 * 管理动作的响应只回摘要。管理台 CommunityPage 丢弃这些响应体、提交后整表重拉；
 * 操作与列表里的 latestOperation 同形，不透出幂等键、申请人、重试调度等内部列。
 */
function toOperationSummary(
  operation: Pick<
    AdminGroupOperation,
    'id' | 'groupID' | 'type' | 'status' | 'lastError' | 'createdAt'
  >,
) {
  return {
    id: operation.id,
    groupID: operation.groupID,
    type: operation.type,
    status: operation.status,
    lastError: operation.lastError,
    createdAt: operation.createdAt,
  };
}

/** 圈子只回管理态相关列，不把整行 Circle 透给管理台。 */
function toCircleAdminView(
  circle: Pick<
    Circle,
    | 'id'
    | 'name'
    | 'groupID'
    | 'deleted'
    | 'adminState'
    | 'adminDisabledAt'
    | 'adminDisabledBy'
    | 'adminDisableReason'
  >,
) {
  return {
    id: circle.id,
    name: circle.name,
    groupID: circle.groupID,
    deleted: circle.deleted,
    adminState: circle.adminState,
    adminDisabledAt: circle.adminDisabledAt,
    adminDisabledBy: circle.adminDisabledBy,
    adminDisableReason: circle.adminDisableReason,
  };
}

@Injectable()
export class AdminCommunityService {
  constructor(private readonly prisma: PrismaService) {}

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
    // The persisted conversation is authoritative; Circle.groupID is a legacy field.
    const conversations = circles.length
      ? await this.prisma.chatConversation.findMany({
          where: {
            circleID: { in: circles.map((circle) => circle.id) },
            type: 'GROUP',
          },
          select: { id: true, circleID: true, name: true },
        })
      : [];
    const conversationByCircle = new Map(
      conversations.map((item) => [item.circleID, item]),
    );
    return {
      items: circles.map((circle) => ({
        ...circle,
        associatedGroup: conversationByCircle.get(circle.id) ?? null,
        latestOperation: circle.groupID
          ? (operations.get(circle.groupID) ?? null)
          : null,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async circleDetail(id: string) {
    const circle = await this.prisma.circle.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        avatarUrl: true,
        cover: true,
        currentIconAsset: { select: { imageUrl: true } },
        cities: true,
        categories: true,
        rules: true,
        tags: true,
        isPublic: true,
        joinVipRestriction: true,
        joinCreditRestriction: true,
        joinFancyRestriction: true,
        maxMembers: true,
        expansionSeats: true,
        memberCanPost: true,
        memberCanInvite: true,
        requiredVerifierCount: true,
        memberCount: true,
        postCount: true,
        deleted: true,
        adminState: true,
        adminDisabledAt: true,
        adminDisabledBy: true,
        adminDisableReason: true,
        createdAt: true,
        updatedAt: true,
        owner: {
          select: {
            id: true,
            accountId: true,
            nickname: true,
            avatarUrl: true,
          },
        },
      },
    });
    if (!circle) throw new NotFoundException('圈子不存在');
    const associatedGroup = await this.prisma.chatConversation.findFirst({
      where: { circleID: id, type: 'GROUP' },
      select: {
        id: true,
        name: true,
        muteAllAt: true,
        textEncryption: true,
        qrJoinEnabled: true,
        cardJoinEnabled: true,
        joinApprovalRequired: true,
        membersCanViewProfiles: true,
        membersCanViewRoster: true,
        membersCanAddFriends: true,
      },
    });
    const { currentIconAsset, ...details } = circle;
    return {
      ...details,
      currentIconUrl: currentIconAsset?.imageUrl ?? null,
      associatedGroup,
    };
  }

  private async assertCircleExists(id: string) {
    if (
      !(await this.prisma.circle.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      throw new NotFoundException('圈子不存在');
  }

  async circleMembers(id: string, query: { page: number; limit: number }) {
    await this.assertCircleExists(id);
    const where = { circleID: id };
    const [items, total] = await Promise.all([
      this.prisma.circleMember.findMany({
        where,
        select: {
          id: true,
          role: true,
          status: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              accountId: true,
              nickname: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.circleMember.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async circlePosts(id: string, query: { page: number; limit: number }) {
    await this.assertCircleExists(id);
    // Multi-circle links are authoritative; retain legacy primary-circle posts too.
    const where: Prisma.CirclePostWhereInput = {
      OR: [{ circleID: id }, { circleLinks: { some: { circleID: id } } }],
    };
    const [items, total] = await Promise.all([
      this.prisma.circlePost.findMany({
        where,
        select: {
          id: true,
          content: true,
          images: true,
          tags: true,
          city: true,
          cities: true,
          isHorn: true,
          noteID: true,
          status: true,
          viewCount: true,
          signupCount: true,
          _count: { select: { signups: true } },
          vipRestriction: true,
          creditRestriction: true,
          fancyRestriction: true,
          signupVipRestriction: true,
          signupCreditRestriction: true,
          signupFancyRestriction: true,
          createdAt: true,
          updatedAt: true,
          endedAt: true,
          expiresAt: true,
          author: {
            select: {
              id: true,
              accountId: true,
              nickname: true,
              avatarUrl: true,
            },
          },
          circle: { select: { id: true, name: true } },
          circleLinks: {
            select: { circle: { select: { id: true, name: true } } },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.circlePost.count({ where }),
    ]);
    return {
      items: items.map(({ _count, ...post }) => ({
        ...post,
        signupCount: _count.signups,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async listGroups(query: { page: number; limit: number; search?: string }) {
    const search = query.search?.trim();
    // Search the authoritative circle name in SQL so matching circles are not
    // truncated to a preloaded subset, and neither IDs nor names are interpolated.
    let matchingIDs: string[] | undefined;
    let matchingTotal: number | undefined;
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const filter = Prisma.sql`FROM "ChatConversation" g LEFT JOIN "Circle" c ON c.id = g."circleID"
        WHERE g.type = 'GROUP' AND (COALESCE(c.name, g.name, '') ILIKE ${pattern} OR g.id ILIKE ${pattern})`;
      const [matches, counts] = await Promise.all([
        this.prisma.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT g.id ${filter} ORDER BY g."createdAt" DESC, g.id DESC OFFSET ${(query.page - 1) * query.limit} LIMIT ${query.limit}`,
        ),
        this.prisma.$queryRaw<{ total: number }[]>(
          Prisma.sql`SELECT COUNT(*)::int AS total ${filter}`,
        ),
      ]);
      matchingIDs = matches.map((row) => row.id);
      matchingTotal = counts[0]?.total ?? 0;
    }
    const where: Prisma.ChatConversationWhereInput = {
      type: 'GROUP',
      ...(matchingIDs ? { id: { in: matchingIDs } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.chatConversation.findMany({
        where,
        select: {
          id: true,
          circleID: true,
          name: true,
          avatarUrl: true,
          ownerID: true,
          muteAllAt: true,
          _count: { select: { members: { where: { leftAt: null } } } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: matchingIDs ? 0 : (query.page - 1) * query.limit,
        take: query.limit,
      }),
      matchingTotal ?? this.prisma.chatConversation.count({ where }),
    ]);
    const circles = rows.length
      ? await this.prisma.circle.findMany({
          where: {
            id: { in: rows.flatMap((r) => (r.circleID ? [r.circleID] : [])) },
          },
          select: {
            id: true,
            name: true,
            groupID: true,
            avatarUrl: true,
            ownerID: true,
            deleted: true,
          },
        })
      : [];
    const circleById = new Map(circles.map((c) => [c.id, c]));
    const ownerIDs = [
      ...new Set(
        rows.flatMap((r) => {
          const owner =
            (r.circleID ? circleById.get(r.circleID)?.ownerID : null) ??
            r.ownerID;
          return owner ? [owner] : [];
        }),
      ),
    ];
    const owners = ownerIDs.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ownerIDs } },
          select: { id: true, nickname: true, accountId: true },
        })
      : [];
    const ownersById = new Map(owners.map((u) => [u.id, u]));
    const operations = await this.latestOperations(
      rows.map((r) => {
        const c = r.circleID ? circleById.get(r.circleID) : null;
        return c ? (c.groupID ?? c.id) : r.id;
      }),
    );
    return {
      items: rows.map((row) => {
        const circle = row.circleID ? circleById.get(row.circleID) : null;
        const ownerUserId = circle?.ownerID ?? row.ownerID;
        const owner = ownerUserId ? ownersById.get(ownerUserId) : null;
        const groupId = circle ? (circle.groupID ?? circle.id) : row.id;
        return {
          groupId,
          conversationId: row.id,
          name: circle?.name ?? row.name ?? '未命名群聊',
          faceUrl: circle ? circle.avatarUrl : row.avatarUrl,
          status: circle?.deleted ? 2 : row.muteAllAt ? 3 : 0,
          muted: !!row.muteAllAt,
          memberCount: row._count.members,
          ownerUserId,
          ownerName: owner?.nickname || owner?.accountId || null,
          linkedCircle: circle ? { id: circle.id, name: circle.name } : null,
          pendingOperation: operations.get(groupId) ?? null,
          managementSupported: !!circle,
        };
      }),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  private async requireGroup(id: string) {
    const group = await this.prisma.chatConversation.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        circleID: true,
        name: true,
        avatarUrl: true,
        notice: true,
        ownerID: true,
        createdAt: true,
        updatedAt: true,
        lastMessageAt: true,
        muteAllAt: true,
        textEncryption: true,
        memberCanInvite: true,
        qrJoinEnabled: true,
        cardJoinEnabled: true,
        joinApprovalRequired: true,
        membersCanViewProfiles: true,
        membersCanViewRoster: true,
        membersCanAddFriends: true,
      },
    });
    if (!group || group.type !== 'GROUP')
      throw new NotFoundException('群聊不存在');
    return group;
  }

  async groupDetail(id: string) {
    const group = await this.requireGroup(id);
    let circle: Awaited<
      ReturnType<AdminCommunityService['circleDetail']>
    > | null = null;
    if (group.circleID) {
      try {
        circle = await this.circleDetail(group.circleID);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    const ownerID = circle?.owner.id ?? group.ownerID;
    const [owner, memberCount] = await Promise.all([
      ownerID
        ? this.prisma.user.findUnique({
            where: { id: ownerID },
            select: {
              id: true,
              nickname: true,
              accountId: true,
              avatarUrl: true,
            },
          })
        : null,
      this.prisma.chatMember.count({
        where: { conversationID: id, leftAt: null },
      }),
    ]);
    return {
      ...group,
      name: circle?.name ?? group.name ?? '未命名群聊',
      avatarUrl: circle ? circle.avatarUrl : group.avatarUrl,
      notice: circle?.description ?? group.notice,
      memberCanInvite: circle?.memberCanInvite ?? group.memberCanInvite,
      owner,
      memberCount,
      circle: circle
        ? {
            id: circle.id,
            name: circle.name,
            deleted: circle.deleted,
            adminState: circle.adminState,
          }
        : null,
    };
  }

  async groupMembers(id: string, query: { page: number; limit: number }) {
    const group = await this.requireGroup(id);
    const where = { conversationID: id };
    const [rows, total] = await Promise.all([
      this.prisma.chatMember.findMany({
        where,
        select: {
          id: true,
          userID: true,
          role: true,
          alias: true,
          joinedAt: true,
          leftAt: true,
          silencedAt: true,
          silencedUntil: true,
        },
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.chatMember.count({ where }),
    ]);
    const userIDs = rows.map((r) => r.userID);
    const [users, memberships] = await Promise.all([
      userIDs.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIDs } },
            select: {
              id: true,
              nickname: true,
              accountId: true,
              avatarUrl: true,
            },
          })
        : [],
      group.circleID && userIDs.length
        ? this.prisma.circleMember.findMany({
            where: {
              circleID: group.circleID,
              userID: { in: userIDs },
              status: 'ACTIVE',
            },
            select: { userID: true, role: true },
          })
        : [],
    ]);
    const userById = new Map(users.map((u) => [u.id, u] as const));
    const roleByUser = new Map(
      memberships.map((m) => [m.userID, m.role] as const),
    );
    return {
      items: rows.map((r) => ({
        ...r,
        role: group.circleID
          ? (roleByUser.get(r.userID) ?? 'MEMBER')
          : r.userID === group.ownerID
            ? 'OWNER'
            : r.role,
        user: userById.get(r.userID) ?? null,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async groupEvents(id: string, query: { page: number; limit: number }) {
    await this.requireGroup(id);
    const where = { conversationID: id };
    const [rows, total] = await Promise.all([
      this.prisma.chatGroupEvent.findMany({
        where,
        select: {
          id: true,
          kind: true,
          actorID: true,
          targetIDs: true,
          payload: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.chatGroupEvent.count({ where }),
    ]);
    const ids = [
      ...new Set(
        rows.flatMap((r) => [
          ...(r.actorID ? [r.actorID] : []),
          ...r.targetIDs,
        ]),
      ),
    ];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            nickname: true,
            accountId: true,
            avatarUrl: true,
          },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u] as const));
    return {
      items: rows.map(({ actorID, targetIDs, ...r }) => ({
        ...r,
        actor: actorID ? (byId.get(actorID) ?? null) : null,
        targets: targetIDs.map(
          (userID) =>
            byId.get(userID) ?? {
              id: userID,
              nickname: '已注销用户',
              accountId: '',
              avatarUrl: null,
            },
        ),
      })),
      total,
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
        // groupID 为空是受支持的历史状态(早年 OpenIM 建群失败时留下的),
        // 而列表接口对外报的正是 `circle.groupID ?? circle.id` —— 只按 groupID
        // 反查的话,这类圈子必然查不到:操作记成 circleID=null,处理器"成功"返回,
        // Circle 却从没被标记 deleted,之后有人打开圈聊,座位又整套重建出来。
        // 管理员看到的是"已解散",实际群聊照常能用。
        // 所以按 id 兜一次底 —— 与列表的取值口径对齐。
        const linkedCircle = await tx.circle.findFirst({
          where: {
            OR: [{ groupID }, { id: groupID, groupID: null }],
          },
          select: {
            id: true,
            name: true,
            deleted: true,
            adminState: true,
          },
        });
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
          return toOperationSummary(duplicate);
        }
        if (linkedCircle && input.type !== 'DISMISS') {
          throw new ConflictException(
            '该群聊已关联圈子，请使用圈子停用或恢复接口',
          );
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
        return toOperationSummary(operation);
      });
    } catch (error) {
      this.rethrowOperationConflict(error);
    }
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
          return {
            circle: toCircleAdminView(circle),
            operation: toOperationSummary(duplicate),
          };
        }
        await this.assertNoActiveOperation(tx, circle.groupID);

        if (type === 'MUTE' && circle.deleted) {
          throw new ConflictException('圈子已经删除，无法停用');
        }
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
        return {
          circle: toCircleAdminView(updatedCircle),
          operation: toOperationSummary(operation),
        };
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
      return { circle: toCircleAdminView(circle), operation: null };
    }

    if (type === 'MUTE' && circle.deleted) {
      throw new ConflictException('圈子已经删除，无法停用');
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
    return { circle: toCircleAdminView(updatedCircle), operation: null };
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
