import { NotFoundException } from '@nestjs/common';
import { AdminCommunityService } from './admin-community.service';
import { PrismaService } from 'src/prisma/prisma.service';
describe('admin full circle details', () => {
  const prisma = {
    circle: { findUnique: jest.fn() },
    chatConversation: { findFirst: jest.fn() },
    circleMember: { findMany: jest.fn(), count: jest.fn() },
    circlePost: { findMany: jest.fn(), count: jest.fn() },
  };
  const service = new AdminCommunityService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle',
      name: '摄影圈',
      description: '简介',
      currentIconAsset: { imageUrl: 'icon.png' },
    });
    prisma.chatConversation.findFirst.mockResolvedValue({ id: 'actual-chat' });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.circleMember.count.mockResolvedValue(0);
    prisma.circlePost.findMany.mockResolvedValue([]);
    prisma.circlePost.count.mockResolvedValue(0);
  });
  it('returns App details and actual group without leaking full user or asset rows', async () => {
    expect(await service.circleDetail('circle')).toEqual({
      id: 'circle',
      name: '摄影圈',
      description: '简介',
      currentIconUrl: 'icon.png',
      associatedGroup: { id: 'actual-chat' },
    });
    const query = prisma.circle.findUnique.mock.calls[0][0];
    expect(query.select.owner.select).toEqual({
      id: true,
      accountId: true,
      nickname: true,
      avatarUrl: true,
    });
    expect(query.select.rules).toBe(true);
    expect(query.select.memberCanInvite).toBe(true);
    expect(prisma.chatConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { circleID: 'circle', type: 'GROUP' } }),
    );
  });
  it.each(['circleDetail', 'circleMembers', 'circlePosts'] as const)(
    '%s rejects nonexistent circles',
    async (method) => {
      prisma.circle.findUnique.mockResolvedValue(null);
      await expect(
        service[method]('missing', { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.circleMember.findMany).not.toHaveBeenCalled();
      expect(prisma.circlePost.findMany).not.toHaveBeenCalled();
    },
  );
  it('scopes and paginates membership without selecting private profile fields', async () => {
    await service.circleMembers('circle', { page: 2, limit: 20 });
    expect(prisma.circleMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { circleID: 'circle' },
        skip: 20,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(
      prisma.circleMember.findMany.mock.calls[0][0].select.user.select,
    ).toEqual({ id: true, accountId: true, nickname: true, avatarUrl: true });
  });
  it('includes multi-circle and legacy posts, keeps historical statuses, and bounds each page', async () => {
    await service.circlePosts('circle', { page: 3, limit: 20 });
    const where = {
      OR: [
        { circleID: 'circle' },
        { circleLinks: { some: { circleID: 'circle' } } },
      ],
    };
    expect(prisma.circlePost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        skip: 40,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(prisma.circlePost.count).toHaveBeenCalledWith({ where });
  });
});
