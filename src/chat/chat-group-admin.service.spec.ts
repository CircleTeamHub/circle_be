import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGroupAdminService } from './chat-group-admin.service';

const membershipNoticesMock = {
  deliverMembershipNotices: jest.fn().mockResolvedValue(undefined),
};

/**
 * 群管理的权限矩阵与锁序:
 * - 先用锁外快照鉴权(非管理员碰不到会话行锁),锁后再用锁后快照重做一遍;
 * - 群主可动管理员/成员,管理员只能动普通成员,谁都动不了群主与自己;
 * - 独立群专属端点打到圈子群上显式拒绝;禁言对两种群都开放;
 * - 变更与群日志同事务,不往聊天里写灰字(群日志只有群主/管理员能看);
 *   当事人的个人房事件(updated / removed)在提交之后发。
 */
describe('ChatGroupAdminService', () => {
  const prisma = {
    chatMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    circleMember: { findUnique: jest.fn(), findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    adminAuditLog: { create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const broadcast = {
    emitConversationChange: jest.fn(),
    removeUserFromConversation: jest.fn().mockResolvedValue(undefined),
  };
  const groupEvents = { recordInTx: jest.fn().mockResolvedValue(undefined) };

  const service = new ChatGroupAdminService(
    prisma as never,
    broadcast as never,
    groupEvents as never,
    membershipNoticesMock as never,
  );

  const conversation = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    type: 'GROUP',
    circleID: null,
    ownerID: 'owner-1',
    name: '读书会',
    ...overrides,
  });
  const seat = (userID: string, overrides: Record<string, unknown> = {}) => ({
    id: `seat-${userID}`,
    conversationID: 'conv-1',
    userID,
    role: 'MEMBER',
    leftAt: null,
    silencedAt: null,
    silencedUntil: null,
    ...overrides,
  });

  /** 锁外快照:本人座位 + 会话;锁后快照:会话行 + 双方座位。 */
  const arrange = (params: {
    conversation?: Record<string, unknown>;
    actor: ReturnType<typeof seat>;
    target: ReturnType<typeof seat> | null;
    circleRoles?: Record<string, string>;
  }) => {
    const row = conversation(params.conversation);
    prisma.chatMember.findUnique.mockResolvedValue({
      ...params.actor,
      conversation: row,
    });
    prisma.$queryRaw.mockResolvedValue([row]);
    prisma.chatMember.findMany.mockResolvedValue(
      [params.actor, params.target].filter(Boolean),
    );
    if (params.circleRoles) {
      prisma.circleMember.findUnique.mockImplementation(
        async ({
          where,
        }: {
          where: { userID_circleID: { userID: string } };
        }) => {
          const role = params.circleRoles?.[where.userID_circleID.userID];
          return role ? { role, status: 'ACTIVE' } : null;
        },
      );
      prisma.circleMember.findMany.mockResolvedValue(
        Object.entries(params.circleRoles).map(([userID, role]) => ({
          userID,
          role,
          status: 'ACTIVE',
        })),
      );
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );
    prisma.chatMember.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...seat('u-2'),
        ...data,
      }),
    );
  });

  describe('setStandaloneMemberRole', () => {
    it('rejects non-owners before taking the conversation lock', async () => {
      arrange({
        actor: seat('admin-1', { role: 'ADMIN' }),
        target: seat('u-2'),
      });
      await expect(
        service.setStandaloneMemberRole('admin-1', 'conv-1', 'u-2', 'ADMIN'),
      ).rejects.toMatchObject({
        constructor: ForbiddenException,
        response: { errorCode: ChatErrorCode.GroupOwnerOnly },
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses circle-managed groups (their roles live in CircleMember)', async () => {
      arrange({
        conversation: { circleID: 'circle-1' },
        actor: seat('owner-1'),
        target: seat('u-2'),
      });
      await expect(
        service.setStandaloneMemberRole('owner-1', 'conv-1', 'u-2', 'ADMIN'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupCircleManaged },
      });
    });

    it('refuses to target yourself', async () => {
      await expect(
        service.setStandaloneMemberRole(
          'owner-1',
          'conv-1',
          'owner-1',
          'ADMIN',
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupSelfTarget },
      });
      expect(prisma.chatMember.findUnique).not.toHaveBeenCalled();
    });

    it('promotes a member: role and group-log entry in one transaction, only the target is told', async () => {
      arrange({ actor: seat('owner-1'), target: seat('u-2') });
      await expect(
        service.setStandaloneMemberRole('owner-1', 'conv-1', 'u-2', 'ADMIN'),
      ).resolves.toEqual({ userId: 'u-2', role: 'ADMIN' });
      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: { id: 'seat-u-2' },
        data: { role: 'ADMIN' },
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'member-role-changed',
        actorId: 'owner-1',
        targetIds: ['u-2'],
        payload: { role: 'ADMIN' },
      });
      // 不写聊天灰字:其他成员不收任何事件,只有当事人刷新自己的角色徽标。
      expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(1);
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u-2', {
        kind: 'updated',
        conversationId: 'conv-1',
        userId: 'u-2',
      });
    });

    it('is idempotent when the member already holds the role', async () => {
      arrange({
        actor: seat('owner-1'),
        target: seat('u-2', { role: 'ADMIN' }),
      });
      await service.setStandaloneMemberRole(
        'owner-1',
        'conv-1',
        'u-2',
        'ADMIN',
      );
      expect(prisma.chatMember.update).not.toHaveBeenCalled();
      expect(groupEvents.recordInTx).not.toHaveBeenCalled();
      expect(broadcast.emitConversationChange).not.toHaveBeenCalled();
    });

    it('reports members that already left as not found', async () => {
      arrange({
        actor: seat('owner-1'),
        target: seat('u-2', { leftAt: new Date() }),
      });
      await expect(
        service.setStandaloneMemberRole('owner-1', 'conv-1', 'u-2', 'ADMIN'),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { errorCode: ChatErrorCode.GroupMemberNotFound },
      });
    });
  });

  describe('removeStandaloneMember', () => {
    it('points self-removal at the leave endpoint', async () => {
      await expect(
        service.removeStandaloneMember('u-2', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupSelfTarget },
      });
    });

    it('lets an admin remove only ordinary members', async () => {
      arrange({
        actor: seat('admin-1', { role: 'ADMIN' }),
        target: seat('admin-2', { role: 'ADMIN' }),
      });
      await expect(
        service.removeStandaloneMember('admin-1', 'conv-1', 'admin-2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupTargetProtected },
      });
      expect(prisma.chatMember.update).not.toHaveBeenCalled();
    });

    it('rejects ordinary members before locking', async () => {
      arrange({ actor: seat('u-3'), target: seat('u-2') });
      await expect(
        service.removeStandaloneMember('u-3', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupManagerOnly },
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('closes the seat, resets the admin flag, keeps silence, and detaches the target', async () => {
      arrange({
        actor: seat('owner-1'),
        target: seat('admin-2', { role: 'ADMIN', silencedAt: new Date() }),
      });
      await service.removeStandaloneMember('owner-1', 'conv-1', 'admin-2');
      const update = prisma.chatMember.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'seat-admin-2' });
      expect(update.data).toEqual({ leftAt: expect.any(Date), role: 'MEMBER' });
      expect(update.data).not.toHaveProperty('silencedAt');
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'member-removed',
        actorId: 'owner-1',
        targetIds: ['admin-2'],
      });
      expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
        'admin-2',
        'conv-1',
      );
      // 踢人只记群日志、不往聊天里写灰字:除了被移出的本人,谁都不收事件。
      expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(1);
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith('admin-2', {
        kind: 'removed',
        conversationId: 'conv-1',
        userId: 'admin-2',
      });
      // 但他会收到一条站内知会(离线也能看到),群名取锁后快照。
      expect(
        membershipNoticesMock.deliverMembershipNotices,
      ).toHaveBeenCalledWith({
        type: 'GROUP_MEMBER_REMOVED',
        toUserIds: ['admin-2'],
        content: '读书会',
      });
    });

    it('leaves the group name empty when the group was never named', async () => {
      arrange({
        conversation: { name: null },
        actor: seat('owner-1'),
        target: seat('u-2'),
      });
      await service.removeStandaloneMember('owner-1', 'conv-1', 'u-2');
      expect(
        membershipNoticesMock.deliverMembershipNotices,
      ).toHaveBeenCalledWith({
        type: 'GROUP_MEMBER_REMOVED',
        toUserIds: ['u-2'],
        content: '',
      });
    });

    it('sends no notice when the removal is rejected', async () => {
      arrange({ actor: seat('u-3'), target: seat('u-2') });
      await expect(
        service.removeStandaloneMember('u-3', 'conv-1', 'u-2'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        membershipNoticesMock.deliverMembershipNotices,
      ).not.toHaveBeenCalled();
    });
  });

  describe('moderateAsAdministrator remove', () => {
    it('leaves the removed member a notice that does not name the administrator', async () => {
      arrange({ actor: seat('owner-1'), target: seat('u-2') });
      prisma.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        adminAccess: { role: 'SUPER_ADMIN' },
      });

      await service.moderateAsAdministrator(
        'platform-admin',
        'conv-1',
        'u-2',
        'remove',
        undefined,
        '违规广告',
      );

      expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u-2', {
        kind: 'removed',
        conversationId: 'conv-1',
        userId: 'u-2',
      });
      // 离线也能看到;知会只带群名,操作者不进通知。
      expect(
        membershipNoticesMock.deliverMembershipNotices,
      ).toHaveBeenCalledWith({
        type: 'GROUP_MEMBER_REMOVED',
        toUserIds: ['u-2'],
        content: '读书会',
      });
    });

    it('sends no membership notice for a console mute', async () => {
      arrange({ actor: seat('owner-1'), target: seat('u-2') });
      prisma.user.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
        adminAccess: { role: 'SUPER_ADMIN' },
      });

      await service.moderateAsAdministrator(
        'platform-admin',
        'conv-1',
        'u-2',
        'mute',
        undefined,
        '刷屏',
      );

      expect(
        membershipNoticesMock.deliverMembershipNotices,
      ).not.toHaveBeenCalled();
      // 平台禁言同样只记群日志;被禁言的人靠 updated 看到输入区横幅。
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'member-silenced',
        actorId: 'platform-admin',
        targetIds: ['u-2'],
        payload: {},
      });
      expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(1);
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u-2', {
        kind: 'updated',
        conversationId: 'conv-1',
        userId: 'u-2',
      });
    });
  });

  describe('silenceMember', () => {
    it('validates the duration before touching the database', async () => {
      await expect(
        service.silenceMember('owner-1', 'conv-1', 'u-2', 30),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { errorCode: ChatErrorCode.SilenceDurationInvalid },
      });
      expect(prisma.chatMember.findUnique).not.toHaveBeenCalled();
    });

    it('rejects ordinary members', async () => {
      arrange({ actor: seat('u-3'), target: seat('u-2') });
      await expect(
        service.silenceMember('u-3', 'conv-1', 'u-2', 600),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupManagerOnly },
      });
    });

    it('sets a timed silence in a standalone group', async () => {
      arrange({ actor: seat('owner-1'), target: seat('u-2') });
      const before = Date.now();
      const result = await service.silenceMember(
        'owner-1',
        'conv-1',
        'u-2',
        600,
      );
      const { data } = prisma.chatMember.update.mock.calls[0][0];
      expect(data.silencedAt).toEqual(expect.any(Date));
      expect(data.silencedUntil.getTime() - data.silencedAt.getTime()).toBe(
        600_000,
      );
      expect(data.silencedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(result).toEqual({
        userId: 'u-2',
        silenced: true,
        silencedUntil: data.silencedUntil.toISOString(),
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'member-silenced',
        actorId: 'owner-1',
        targetIds: ['u-2'],
        payload: { durationSec: 600 },
      });
      // 不写聊天灰字:只有被禁言的人收到 updated,好立刻看到输入区横幅。
      expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(1);
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u-2', {
        kind: 'updated',
        conversationId: 'conv-1',
        userId: 'u-2',
      });
    });

    it('null duration means until lifted', async () => {
      arrange({ actor: seat('owner-1'), target: seat('u-2') });
      const result = await service.silenceMember(
        'owner-1',
        'conv-1',
        'u-2',
        null,
      );
      expect(
        prisma.chatMember.update.mock.calls[0][0].data.silencedUntil,
      ).toBeNull();
      expect(result).toEqual({
        userId: 'u-2',
        silenced: true,
        silencedUntil: null,
      });
    });

    it('reads circle roles for circle groups and lets an admin silence a member', async () => {
      arrange({
        conversation: { circleID: 'circle-1', ownerID: null },
        actor: seat('admin-1'),
        target: seat('u-2'),
        circleRoles: { 'admin-1': 'ADMIN', 'u-2': 'MEMBER' },
      });
      await expect(
        service.silenceMember('admin-1', 'conv-1', 'u-2', 3600),
      ).resolves.toMatchObject({ silenced: true });
      expect(prisma.circleMember.findMany).toHaveBeenCalled();
    });

    it('never lets an admin silence the owner or a peer admin', async () => {
      arrange({
        conversation: { circleID: 'circle-1', ownerID: null },
        actor: seat('admin-1'),
        target: seat('owner-1'),
        circleRoles: { 'admin-1': 'ADMIN', 'owner-1': 'OWNER' },
      });
      await expect(
        service.silenceMember('admin-1', 'conv-1', 'owner-1', 3600),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupTargetProtected },
      });
      arrange({
        actor: seat('admin-1', { role: 'ADMIN' }),
        target: seat('admin-2', { role: 'ADMIN' }),
      });
      await expect(
        service.silenceMember('admin-1', 'conv-1', 'admin-2', 3600),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupTargetProtected },
      });
    });
  });

  describe('unsilenceMember', () => {
    it('is idempotent for members that are not silenced', async () => {
      arrange({ actor: seat('owner-1'), target: seat('u-2') });
      await expect(
        service.unsilenceMember('owner-1', 'conv-1', 'u-2'),
      ).resolves.toEqual({
        userId: 'u-2',
        silenced: false,
        silencedUntil: null,
      });
      expect(prisma.chatMember.update).not.toHaveBeenCalled();
      expect(groupEvents.recordInTx).not.toHaveBeenCalled();
      expect(broadcast.emitConversationChange).not.toHaveBeenCalled();
    });

    it('treats an expired timed silence as already lifted', async () => {
      arrange({
        actor: seat('owner-1'),
        target: seat('u-2', {
          silencedAt: new Date(Date.now() - 7_200_000),
          silencedUntil: new Date(Date.now() - 3_600_000),
        }),
      });
      await service.unsilenceMember('owner-1', 'conv-1', 'u-2');
      expect(prisma.chatMember.update).not.toHaveBeenCalled();
    });

    it('clears an active silence and logs it', async () => {
      arrange({
        actor: seat('owner-1'),
        target: seat('u-2', { silencedAt: new Date(), silencedUntil: null }),
      });
      prisma.chatMember.update.mockResolvedValue(seat('u-2'));
      await expect(
        service.unsilenceMember('owner-1', 'conv-1', 'u-2'),
      ).resolves.toEqual({
        userId: 'u-2',
        silenced: false,
        silencedUntil: null,
      });
      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: { id: 'seat-u-2' },
        data: { silencedAt: null, silencedUntil: null },
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'member-unsilenced',
        actorId: 'owner-1',
        targetIds: ['u-2'],
      });
      expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(1);
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u-2', {
        kind: 'updated',
        conversationId: 'conv-1',
        userId: 'u-2',
      });
    });
  });

  /** 聊天里给群主/管理员的发言标身份:普通成员也要拿得到,不受「显示群成员」限制。 */
  describe('listManagers', () => {
    it('lists the standalone owner and seated admins to an ordinary member', async () => {
      prisma.chatMember.findUnique.mockResolvedValue({
        ...seat('u-2'),
        conversation: conversation({ membersCanViewRoster: false }),
      });
      prisma.chatMember.findMany.mockResolvedValue([
        seat('owner-1'),
        seat('admin-1', { role: 'ADMIN' }),
      ]);
      await expect(service.listManagers('u-2', 'conv-1')).resolves.toEqual([
        { userId: 'owner-1', role: 'OWNER' },
        { userId: 'admin-1', role: 'ADMIN' },
      ]);
      expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          leftAt: null,
          OR: [{ role: 'ADMIN' }, { userID: 'owner-1' }],
        },
        select: { userID: true },
      });
    });

    it('lists only circle managers who still hold a seat in the group', async () => {
      prisma.chatMember.findUnique.mockResolvedValue({
        ...seat('u-2'),
        conversation: conversation({ circleID: 'circle-1', ownerID: null }),
      });
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'MEMBER',
        status: 'ACTIVE',
      });
      prisma.circleMember.findMany.mockResolvedValue([
        { userID: 'c-owner', role: 'OWNER' },
        { userID: 'c-admin', role: 'ADMIN' },
        { userID: 'c-admin-away', role: 'ADMIN' },
      ]);
      prisma.chatMember.findMany.mockResolvedValue([
        { userID: 'c-owner' },
        { userID: 'c-admin' },
      ]);
      await expect(service.listManagers('u-2', 'conv-1')).resolves.toEqual([
        { userId: 'c-owner', role: 'OWNER' },
        { userId: 'c-admin', role: 'ADMIN' },
      ]);
      expect(prisma.circleMember.findMany).toHaveBeenCalledWith({
        where: {
          circleID: 'circle-1',
          status: 'ACTIVE',
          role: { in: ['OWNER', 'ADMIN'] },
        },
        select: { userID: true, role: true },
      });
      expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          leftAt: null,
          userID: { in: ['c-owner', 'c-admin', 'c-admin-away'] },
        },
        select: { userID: true },
      });
    });

    it('skips the seat lookup when the circle has no managers', async () => {
      prisma.chatMember.findUnique.mockResolvedValue({
        ...seat('u-2'),
        conversation: conversation({ circleID: 'circle-1', ownerID: null }),
      });
      prisma.circleMember.findMany.mockResolvedValue([]);
      await expect(service.listManagers('u-2', 'conv-1')).resolves.toEqual([]);
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    });

    it('rejects someone who has left the group', async () => {
      prisma.chatMember.findUnique.mockResolvedValue({
        ...seat('u-2', { leftAt: new Date() }),
        conversation: conversation(),
      });
      await expect(service.listManagers('u-2', 'conv-1')).rejects.toMatchObject(
        { response: { errorCode: ChatErrorCode.NotMember } },
      );
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    });
  });
});
