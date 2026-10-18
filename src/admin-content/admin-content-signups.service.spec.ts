import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminContentService } from './admin-content.service';
describe('admin post signup visibility', () => {
  const prisma = {
    circlePost: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    circlePostSignup: { findMany: jest.fn(), count: jest.fn() },
    circlePostReport: { groupBy: jest.fn(), count: jest.fn() },
  };
  const service = new AdminContentService(prisma as unknown as PrismaService);
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.circlePost.findUnique.mockResolvedValue({
      id: 'post',
      _count: { signups: 3 },
    });
    prisma.circlePost.findMany.mockResolvedValue([
      { id: 'post', _count: { signups: 3 } },
    ]);
    prisma.circlePost.count.mockResolvedValue(1);
    prisma.circlePostSignup.findMany.mockResolvedValue([
      {
        id: 'signup',
        user: { id: 'user', nickname: '小明' },
        seenByAuthor: false,
      },
    ]);
    prisma.circlePostSignup.count.mockResolvedValue(21);
  });
  it('uses actual signup rows for content-list and detail counts without querying reports', async () => {
    expect(await service.list({ page: 1, limit: 20 })).toMatchObject({
      items: [{ id: 'post', signupCount: 3 }],
    });
    expect(await service.detail('post')).toEqual({
      id: 'post',
      signupCount: 3,
    });
    expect(prisma.circlePostReport.groupBy).not.toHaveBeenCalled();
    expect(prisma.circlePostReport.count).not.toHaveBeenCalled();
    expect(prisma.circlePost.findMany.mock.calls[0][0].select._count).toEqual({
      select: { signups: true },
    });
  });
  it('scopes and stably paginates the roster while returning only public user summary fields', async () => {
    const result = await service.signups('post', { page: 2, limit: 20 });
    expect(result).toMatchObject({
      total: 21,
      page: 2,
      items: [{ id: 'signup', seenByAuthor: false }],
    });
    expect(prisma.circlePostSignup.findMany).toHaveBeenCalledWith({
      where: { postID: 'post' },
      select: {
        id: true,
        createdAt: true,
        seenByAuthor: true,
        seenAt: true,
        user: {
          select: {
            id: true,
            nickname: true,
            accountId: true,
            avatarUrl: true,
            status: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 20,
    });
    expect(prisma.circlePostSignup.count).toHaveBeenCalledWith({
      where: { postID: 'post' },
    });
  });
  it('distinguishes an empty roster from a missing post', async () => {
    prisma.circlePostSignup.findMany.mockResolvedValue([]);
    prisma.circlePostSignup.count.mockResolvedValue(0);
    expect(await service.signups('post', { page: 1, limit: 20 })).toMatchObject(
      { items: [], total: 0 },
    );
    prisma.circlePost.findUnique.mockResolvedValue(null);
    await expect(
      service.signups('missing', { page: 1, limit: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.circlePostSignup.findMany).toHaveBeenCalledTimes(1);
  });
});
