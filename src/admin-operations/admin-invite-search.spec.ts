import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminInviteService } from './admin-invite.service';
import {
  buildCampaignSearchCountQuery,
  buildCampaignSearchPageQuery,
  buildReferralSearchCountQuery,
  buildReferralSearchPageQuery,
} from './admin-invite-search.query';

/**
 * 活动码 / 邀请关系列表带关键词时,先用 UNION 查询取当前页 id 和 total(真库对照见
 * test/postgres/admin-search-union.pg-spec.ts),再按 id 回查行并保持页内顺序。
 */
describe('invite list keyword search', () => {
  const USER_SUMMARY = {
    id: true,
    accountId: true,
    nickname: true,
    status: true,
  };

  function setup(pageIDs = ['b', 'a', 'c'], total = 7) {
    const row = (id: string) => ({ id });
    const prisma = {
      $queryRaw: jest.fn((query: Prisma.Sql) =>
        Promise.resolve(
          /COUNT\(\*\)/.test(query.sql)
            ? [{ total }]
            : pageIDs.map((id) => ({ id })),
        ),
      ),
      $transaction: jest.fn((queries: unknown[]) => Promise.all(queries)),
      campaignInvite: {
        findMany: jest.fn().mockResolvedValue([...pageIDs].reverse().map(row)),
        count: jest.fn(),
      },
      referral: {
        findMany: jest.fn().mockResolvedValue([...pageIDs].reverse().map(row)),
        count: jest.fn(),
      },
    };
    return {
      prisma,
      service: new AdminInviteService(prisma as unknown as PrismaService),
    };
  }

  const rawCalls = (prisma: ReturnType<typeof setup>['prisma']) =>
    prisma.$queryRaw.mock.calls.map(([query]) => query);

  describe('campaigns', () => {
    it('pages and counts through the UNION query in one transaction, then hydrates in order', async () => {
      const { prisma, service } = setup();

      const result = await service.campaigns({
        page: 3,
        limit: 3,
        search: 'alice',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [page, count] = rawCalls(prisma);
      const expectedPage = buildCampaignSearchPageQuery({
        search: 'alice',
        limit: 3,
        offset: 6,
      });
      expect(page.sql).toBe(expectedPage.sql);
      expect(page.values).toEqual(expectedPage.values);
      expect(count.sql).toBe(
        buildCampaignSearchCountQuery({ search: 'alice' }).sql,
      );
      expect(prisma.campaignInvite.count).not.toHaveBeenCalled();
      expect(prisma.campaignInvite.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['b', 'a', 'c'] } },
        include: { owner: { select: USER_SUMMARY } },
      });
      expect(result).toEqual({
        items: [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
        total: 7,
        page: 3,
        limit: 3,
      });
    });

    it('skips the hydration query for an empty page', async () => {
      const { prisma, service } = setup([], 2);

      const result = await service.campaigns({
        page: 5,
        limit: 20,
        search: 'alice',
      });

      expect(prisma.campaignInvite.findMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({ items: [], total: 2 });
    });

    it('keeps the plain Prisma list when there is no keyword', async () => {
      const { prisma, service } = setup();
      prisma.campaignInvite.count.mockResolvedValue(0);

      await service.campaigns({ page: 1, limit: 20 });

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.campaignInvite.findMany.mock.calls[0][0]).toMatchObject({
        where: {},
        skip: 0,
        take: 20,
      });
    });
  });

  describe('referrals', () => {
    it('passes status and campaign filters into the UNION query and hydrates in order', async () => {
      const { prisma, service } = setup();

      const result = await service.referrals({
        page: 1,
        limit: 3,
        search: 'alice',
        status: 'REWARDED',
        campaignID: 'f3b0c442-98fc-4c14-9a3d-62a1c1a0d0e1',
      });

      const input = {
        search: 'alice',
        status: 'REWARDED' as const,
        campaignID: 'f3b0c442-98fc-4c14-9a3d-62a1c1a0d0e1',
      };
      const [page, count] = rawCalls(prisma);
      const expectedPage = buildReferralSearchPageQuery({
        ...input,
        limit: 3,
        offset: 0,
      });
      const expectedCount = buildReferralSearchCountQuery(input);
      expect(page.sql).toBe(expectedPage.sql);
      expect(page.values).toEqual(expectedPage.values);
      expect(count.sql).toBe(expectedCount.sql);
      expect(count.values).toEqual(expectedCount.values);
      expect(prisma.referral.count).not.toHaveBeenCalled();

      const hydrate = prisma.referral.findMany.mock.calls[0][0];
      expect(hydrate.where).toEqual({ id: { in: ['b', 'a', 'c'] } });
      expect(hydrate.select).toMatchObject({
        inviter: { select: USER_SUMMARY },
        invitee: { select: USER_SUMMARY },
        failureReason: true,
      });
      expect(result).toEqual({
        items: [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
        total: 7,
        page: 1,
        limit: 3,
      });
    });

    it('keeps the plain Prisma list (with its filters) when there is no keyword', async () => {
      const { prisma, service } = setup();
      prisma.referral.count.mockResolvedValue(0);

      await service.referrals({ page: 2, limit: 10, status: 'PENDING' });

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.referral.findMany.mock.calls[0][0]).toMatchObject({
        where: { status: 'PENDING' },
        skip: 10,
        take: 10,
      });
    });
  });
});
