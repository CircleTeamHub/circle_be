import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAccessService } from './admin-access.service';
import {
  buildAdminListCountQuery,
  buildAdminListPageQuery,
} from './admin-access-list.query';

/**
 * 管理员列表改走原生 SQL(谓词是字面量才能用上部分索引,见 admin-access-list.query.ts)。
 * 结果与原 Prisma 查询一致由真库对照测试钉住(test/postgres/index-admin-console.pg-spec.ts);
 * 这里钉住 service 的接线和响应形状。
 */
describe('administrator list', () => {
  function setup(
    rows: unknown[] = [
      {
        id: 'a1',
        accountId: 'ops',
        nickname: '运营',
        status: 'ACTIVE',
        consoleRole: 'SUPER_ADMIN',
        version: 3,
      },
      {
        id: 'a2',
        accountId: 'legacy',
        nickname: '旧管理员',
        status: 'BANNED',
        consoleRole: null,
        version: null,
      },
    ],
    total = 2,
  ) {
    const prisma = {
      $queryRaw: jest.fn((query: Prisma.Sql) =>
        /COUNT\(\*\)/.test(query.sql) ? [{ total }] : rows,
      ),
      $transaction: jest.fn((queries: unknown[]) => Promise.all(queries)),
      user: { findMany: jest.fn(), count: jest.fn() },
    };
    return {
      prisma,
      service: new AdminAccessService(prisma as unknown as PrismaService),
    };
  }

  it('reads the page and the total through the literal-predicate SQL in one transaction', async () => {
    const { prisma, service } = setup();

    await service.list({ page: 3, limit: 20, search: 'ops' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [page, count] = prisma.$queryRaw.mock.calls.map(([query]) => query);
    const expectedPage = buildAdminListPageQuery({
      search: 'ops',
      limit: 20,
      offset: 40,
    });
    const expectedCount = buildAdminListCountQuery({ search: 'ops' });
    expect(page.sql).toBe(expectedPage.sql);
    expect(page.values).toEqual(expectedPage.values);
    expect(count.sql).toBe(expectedCount.sql);
    expect(count.values).toEqual(expectedCount.values);
    // 不再走 Prisma 的枚举参数化查询(用不上部分索引)。
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('keeps the response shape: console role and version default when there is no grant', async () => {
    const { service } = setup();

    expect(await service.list({ page: 1, limit: 20 })).toEqual({
      items: [
        {
          id: 'a1',
          accountId: 'ops',
          nickname: '运营',
          status: 'ACTIVE',
          consoleRole: 'SUPER_ADMIN',
          version: 3,
        },
        {
          id: 'a2',
          accountId: 'legacy',
          nickname: '旧管理员',
          status: 'BANNED',
          consoleRole: null,
          version: 0,
        },
      ],
      total: 2,
      page: 1,
      limit: 20,
    });
  });

  it('writes ADMIN / DELETED as SQL literals and binds only the search and paging values', () => {
    const page = buildAdminListPageQuery({
      search: '100%',
      limit: 20,
      offset: 0,
    });
    expect(page.sql).toContain(`u."role" = 'ADMIN'`);
    expect(page.sql).toContain(`u."status" <> 'DELETED'`);
    expect(page.values).toEqual(['100%', '100%', 20, 0]);

    const unfiltered = buildAdminListCountQuery({});
    expect(unfiltered.sql).not.toContain('ILIKE');
    expect(unfiltered.values).toEqual([]);
  });
});
