import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminCommunityService } from './admin-community.service';
describe('complete group details', () => {
  const prisma = {
    chatConversation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    circle: { findUnique: jest.fn(), findMany: jest.fn() },
    chatMember: { findMany: jest.fn(), count: jest.fn() },
    circleMember: { findMany: jest.fn() },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    chatGroupEvent: { findMany: jest.fn(), count: jest.fn() },
    adminGroupOperation: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const service = new AdminCommunityService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.chatConversation.findUnique.mockResolvedValue({
      id: 'group',
      type: 'GROUP',
      circleID: null,
      name: '朋友群',
      ownerID: 'owner',
      notice: '公告',
      memberCanInvite: false,
    });
    prisma.user.findUnique.mockResolvedValue({ id: 'owner', nickname: '群主' });
    prisma.user.findMany.mockResolvedValue([
      { id: 'member', nickname: '小明', accountId: 'ming', avatarUrl: null },
    ]);
    prisma.chatMember.count.mockResolvedValue(1);
    prisma.chatMember.findMany.mockResolvedValue([
      {
        id: 'seat',
        userID: 'member',
        role: 'MEMBER',
        alias: '群昵称',
        leftAt: null,
      },
    ]);
    prisma.chatGroupEvent.findMany.mockResolvedValue([]);
    prisma.chatGroupEvent.count.mockResolvedValue(0);
    prisma.adminGroupOperation.findMany.mockResolvedValue([]);
  });
  it.each(['groupDetail', 'groupMembers', 'groupEvents'] as const)(
    '%s rejects direct sessions and nonexistent groups',
    async (method) => {
      prisma.chatConversation.findUnique.mockResolvedValue({ type: 'DIRECT' });
      await expect(
        service[method]('direct', { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
      expect(prisma.chatGroupEvent.findMany).not.toHaveBeenCalled();
    },
  );
  it('returns independent group metadata, owner and current member count', async () => {
    expect(await service.groupDetail('group')).toMatchObject({
      id: 'group',
      name: '朋友群',
      notice: '公告',
      memberCanInvite: false,
      owner: { id: 'owner' },
      memberCount: 1,
      circle: null,
    });
    expect(prisma.chatMember.count).toHaveBeenCalledWith({
      where: { conversationID: 'group', leftAt: null },
    });
  });
  it('uses canonical circle name, notice and policies over stale conversation copies', async () => {
    prisma.chatConversation.findUnique.mockResolvedValue({
      id: 'group',
      type: 'GROUP',
      circleID: 'circle',
      name: '旧群名',
      avatarUrl: 'https://example.test/stale.jpg',
      notice: '旧公告',
      memberCanInvite: false,
    });
    jest.spyOn(service, 'circleDetail').mockResolvedValueOnce({
      id: 'circle',
      name: '新圈名',
      description: '新公告',
      avatarUrl: null,
      memberCanInvite: true,
      owner: { id: 'owner' },
      deleted: false,
      adminState: 'ACTIVE',
    } as never);
    expect(await service.groupDetail('group')).toMatchObject({
      name: '新圈名',
      avatarUrl: null,
      notice: '新公告',
      memberCanInvite: true,
      circle: { id: 'circle' },
    });
  });
  it('keeps persisted group details readable when the linked circle was removed', async () => {
    prisma.chatConversation.findUnique.mockResolvedValue({
      id: 'group',
      type: 'GROUP',
      circleID: 'removed',
      name: '保留群聊',
      ownerID: null,
    });
    jest
      .spyOn(service, 'circleDetail')
      .mockRejectedValueOnce(new NotFoundException());
    expect(await service.groupDetail('group')).toMatchObject({
      name: '保留群聊',
      circleID: 'removed',
      circle: null,
    });
  });
  it('uses circle membership roles and does not expose private per-user chat preferences', async () => {
    prisma.chatConversation.findUnique.mockResolvedValue({
      id: 'group',
      type: 'GROUP',
      circleID: 'circle',
    });
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'member', role: 'ADMIN' },
    ]);
    const result = await service.groupMembers('group', { page: 2, limit: 20 });
    expect(result.items[0]).toMatchObject({
      role: 'ADMIN',
      alias: '群昵称',
      user: { nickname: '小明' },
    });
    const query = prisma.chatMember.findMany.mock.calls[0][0];
    expect(query).toMatchObject({
      where: { conversationID: 'group' },
      skip: 20,
      take: 20,
    });
    expect(query.select).not.toHaveProperty('remark');
    expect(query.select).not.toHaveProperty('lastReadHeight');
    expect(prisma.user.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      nickname: true,
      accountId: true,
      avatarUrl: true,
    });
  });
  it('includes independent groups, preserves operation IDs for circle groups, and counts actual active seats', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      {
        id: 'independent',
        circleID: null,
        name: '独立群',
        ownerID: 'member',
        muteAllAt: null,
        _count: { members: 3 },
      },
      {
        id: 'circle-chat',
        circleID: 'circle',
        name: '旧名',
        ownerID: null,
        muteAllAt: new Date(),
        _count: { members: 2 },
      },
    ]);
    prisma.chatConversation.count.mockResolvedValue(2);
    prisma.circle.findMany.mockResolvedValue([
      { id: 'circle', groupID: 'legacy', name: '圈子群', ownerID: 'member' },
    ]);
    const result = await service.listGroups({ page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({
      conversationId: 'independent',
      managementSupported: false,
      memberCount: 3,
      linkedCircle: null,
    });
    expect(result.items[1]).toMatchObject({
      groupId: 'legacy',
      conversationId: 'circle-chat',
      managementSupported: true,
      name: '圈子群',
      memberCount: 2,
      muted: true,
    });
  });
  it('searches all authoritative circle names with bound SQL and paginates before loading full rows', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'group' }])
      .mockResolvedValueOnce([{ total: 250 }]);
    prisma.chatConversation.findMany.mockResolvedValue([
      {
        id: 'group',
        circleID: null,
        ownerID: null,
        name: '摄影',
        _count: { members: 1 },
      },
    ]);
    prisma.circle.findMany.mockResolvedValue([]);
    const result = await service.listGroups({
      page: 3,
      limit: 20,
      search: "摄影' OR 1=1",
    });
    expect(result.total).toBe(250);
    expect(prisma.chatConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'GROUP', id: { in: ['group'] } },
        skip: 0,
        take: 20,
      }),
    );
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain("%摄影' OR 1=1%");
    expect(sql.values).toContain(40);
    expect(sql.sql).not.toContain("摄影' OR 1=1");
  });
  it('paginates group logs and resolves actors and deleted targets without returning raw user records', async () => {
    prisma.chatGroupEvent.findMany.mockResolvedValue([
      {
        id: 'event',
        kind: 'member-removed',
        actorID: 'member',
        targetIDs: ['deleted'],
        payload: {},
        createdAt: new Date(),
      },
    ]);
    const result = await service.groupEvents('group', { page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({
      actor: { nickname: '小明' },
      targets: [{ id: 'deleted', nickname: '已注销用户' }],
    });
    expect(result.items[0]).not.toHaveProperty('actorID');
    expect(prisma.chatGroupEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationID: 'group' },
        take: 20,
        skip: 0,
      }),
    );
  });
});
