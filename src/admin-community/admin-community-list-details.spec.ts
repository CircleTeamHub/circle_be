import { AdminCommunityService } from './admin-community.service';
import { PrismaService } from 'src/prisma/prisma.service';
describe('actual circle group associations', () => {
  const circles = [
    { id: 'circle-new', name: '新圈子', groupID: null },
    { id: 'circle-legacy', name: '旧圈子', groupID: 'legacy-id' },
  ];
  function setup() {
    const prisma = {
      circle: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue(circles),
      },
      adminGroupOperation: { findMany: jest.fn().mockResolvedValue([]) },
      chatConversation: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'real-group', circleID: 'circle-new', name: '实际群聊' },
          ]),
      },
    };
    return {
      prisma,
      service: new AdminCommunityService(prisma as unknown as PrismaService),
    };
  }
  it('finds a persisted group when the legacy group field is empty, and never invents a group from a legacy ID', async () => {
    const { prisma, service } = setup();
    const result = await service.listCircles({ page: 1, limit: 20 });
    expect(result.items[0].associatedGroup).toEqual({
      id: 'real-group',
      circleID: 'circle-new',
      name: '实际群聊',
    });
    expect(result.items[1].associatedGroup).toBeNull();
    expect(prisma.chatConversation.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatConversation.findMany).toHaveBeenCalledWith({
      where: {
        circleID: { in: ['circle-new', 'circle-legacy'] },
        type: 'GROUP',
      },
      select: { id: true, circleID: true, name: true },
    });
  });
  it('does not query conversations when the page is empty', async () => {
    const { prisma, service } = setup();
    prisma.circle.findMany.mockResolvedValue([]);
    await service.listCircles({ page: 1, limit: 20 });
    expect(prisma.chatConversation.findMany).not.toHaveBeenCalled();
  });
});
