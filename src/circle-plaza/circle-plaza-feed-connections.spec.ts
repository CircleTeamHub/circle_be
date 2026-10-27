import { ConfigService } from '@nestjs/config';
import { AvatarFrameService } from 'src/avatar-frame/avatar-frame.service';
import { IconService } from 'src/icon/icon.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { encodeFeedCursor } from 'src/utils/feed-cursor';
import { CirclePlazaService } from './circle-plaza.service';

/**
 * 广场 feed 的 offset(页码)路径此前 Promise.all([findMany, count]):每个请求同时占
 * 两条池连接,而 count 要把可见范围内的帖子全数一遍,是两条里慢的那条。高峰时整池
 * 被 feed 一个接口吃一半。改成先取当页、再数总数 —— 同一时刻只占一条连接,返回不变。
 */
describe('CirclePlazaService feed connection usage', () => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        vipLevel: 1,
        vipExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
        creditScore: 100,
        fancyNumber: false,
      }),
    },
    circlePost: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    circlePostSignup: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const membershipPolicy = {
    resolveEntitlement: jest.fn().mockResolvedValue({
      level: 1,
      tier: { quotas: { cityFilters: { actual: 10 } } },
    }),
  };
  const service = new CirclePlazaService(
    prisma as unknown as PrismaService,
    { get: jest.fn(() => null) } as unknown as ConfigService,
    {} as RealtimeService,
    {} as NotificationService,
    {
      getDisplayIconsForUsers: jest.fn().mockResolvedValue(new Map()),
    } as unknown as IconService,
    membershipPolicy as unknown as MembershipPolicyService,
    {
      resolvePublicAppearances: jest.fn().mockResolvedValue(new Map()),
    } as unknown as AvatarFrameService,
  );

  beforeEach(() => {
    prisma.circlePost.findMany.mockReset();
    prisma.circlePost.count.mockReset();
  });

  it('runs the offset page query and its count one after the other', async () => {
    let releasePage!: (rows: unknown[]) => void;
    prisma.circlePost.findMany.mockReturnValue(
      new Promise((resolve) => {
        releasePage = resolve;
      }),
    );
    prisma.circlePost.count.mockResolvedValue(0);

    const feed = service.getFeed('viewer-1', { page: 2, limit: 10 });
    // 让 getFeed 跑到取当页那一步并挂起在那里。
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.circlePost.findMany).toHaveBeenCalledTimes(1);
    // 当页还没回来，count 不能已经占了第二条连接。
    expect(prisma.circlePost.count).not.toHaveBeenCalled();

    releasePage([]);
    await expect(feed).resolves.toEqual(
      expect.objectContaining({
        items: [],
        total: 0,
        page: 2,
        limit: 10,
        hasMore: false,
        nextCursor: null,
      }),
    );
    expect(prisma.circlePost.count).toHaveBeenCalledTimes(1);
    expect(prisma.circlePost.count.mock.calls[0][0].where).toBe(
      prisma.circlePost.findMany.mock.calls[0][0].where,
    );
    expect(prisma.circlePost.findMany.mock.calls[0][0]).toEqual(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('keeps total exact for the legacy page-number UI', async () => {
    prisma.circlePost.findMany.mockResolvedValue([]);
    prisma.circlePost.count.mockResolvedValue(37);

    await expect(
      service.getFeed('viewer-1', { page: 4, limit: 10 }),
    ).resolves.toEqual(expect.objectContaining({ total: 37, hasMore: true }));
  });

  it('never counts on the keyset path', async () => {
    prisma.circlePost.findMany.mockResolvedValue([]);

    await expect(
      service.getFeed('viewer-1', {
        cursor: encodeFeedCursor(new Date('2026-06-01T00:00:00.000Z'), 'p1'),
        limit: 10,
      }),
    ).resolves.toEqual(expect.objectContaining({ total: null }));
    expect(prisma.circlePost.count).not.toHaveBeenCalled();
  });
});
