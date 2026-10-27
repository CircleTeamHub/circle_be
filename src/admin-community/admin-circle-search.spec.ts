import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminCommunityService } from './admin-community.service';
import {
  buildCircleSearchCountQuery,
  buildCircleSearchPageQuery,
} from './admin-circle-search.query';

/**
 * 圈子列表带关键词时,先用 UNION 查询取当前页 id 和 total(真库对照见
 * test/postgres/admin-search-union.pg-spec.ts),再按 id 回查行并保持页内顺序。
 */
describe('circle list keyword search', () => {
  const circle = (id: string) => ({
    id,
    name: id,
    groupID: null,
    owner: { id: 'u1', accountId: 'alice', nickname: 'Alice' },
  });

  function setup(pageIDs = ['c3', 'c1', 'c2'], total = 9) {
    const prisma = {
      $queryRaw: jest.fn((query: Prisma.Sql) =>
        Promise.resolve(
          /COUNT\(\*\)/.test(query.sql)
            ? [{ total }]
            : pageIDs.map((id) => ({ id })),
        ),
      ),
      circle: {
        count: jest.fn(),
        // 回查结果故意乱序:页内顺序必须以 UNION 查询为准。
        findMany: jest.fn().mockResolvedValue(
          [...pageIDs]
            .reverse()
            .filter((id) => id !== 'gone')
            .map(circle),
        ),
      },
      adminGroupOperation: { findMany: jest.fn().mockResolvedValue([]) },
      chatConversation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return {
      prisma,
      service: new AdminCommunityService(prisma as unknown as PrismaService),
    };
  }

  it('pages and counts through the UNION query, then hydrates the page in order', async () => {
    const { prisma, service } = setup();

    const result = await service.listCircles({
      page: 2,
      limit: 3,
      search: '  alice ',
      status: 'DISABLED',
    });

    const [page, count] = prisma.$queryRaw.mock.calls.map(([query]) => query);
    const expectedPage = buildCircleSearchPageQuery({
      search: 'alice',
      status: 'DISABLED',
      limit: 3,
      offset: 3,
    });
    const expectedCount = buildCircleSearchCountQuery({
      search: 'alice',
      status: 'DISABLED',
    });
    expect(page.sql).toBe(expectedPage.sql);
    expect(page.values).toEqual(expectedPage.values);
    expect(count.sql).toBe(expectedCount.sql);
    expect(count.values).toEqual(expectedCount.values);

    expect(prisma.circle.count).not.toHaveBeenCalled();
    const hydrate = prisma.circle.findMany.mock.calls[0][0];
    expect(hydrate.where).toEqual({ id: { in: ['c3', 'c1', 'c2'] } });
    expect(hydrate).not.toHaveProperty('skip');
    expect(hydrate.select).toMatchObject({
      memberCount: true,
      owner: { select: { id: true, accountId: true, nickname: true } },
    });
    expect(result.items.map((item) => item.id)).toEqual(['c3', 'c1', 'c2']);
    expect(result).toMatchObject({ total: 9, page: 2, limit: 3 });
  });

  it('skips the hydration query for an empty page', async () => {
    const { prisma, service } = setup([], 4);

    const result = await service.listCircles({
      page: 9,
      limit: 20,
      search: 'alice',
    });

    expect(prisma.circle.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ items: [], total: 4 });
  });

  it('drops a circle that disappeared between the page query and the hydration', async () => {
    const { service } = setup(['c3', 'gone', 'c2']);

    const result = await service.listCircles({
      page: 1,
      limit: 20,
      search: 'alice',
    });

    expect(result.items.map((item) => item.id)).toEqual(['c3', 'c2']);
  });

  it('keeps the plain Prisma list when there is no keyword', async () => {
    const { prisma, service } = setup();
    prisma.circle.count.mockResolvedValue(2);

    await service.listCircles({ page: 1, limit: 20, search: '   ' });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.circle.findMany.mock.calls[0][0]).toMatchObject({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
  });
});
