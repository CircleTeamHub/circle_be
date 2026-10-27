import { FAILED_AUDIT_WHERE } from '../admin-operations/audit-record-kind';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { ConsoleInsightsService } from './console-insights.service';

describe('readable console diagnostics', () => {
  const at = new Date('2026-10-17T00:00:00Z');
  function setup(rows: unknown[] = []) {
    const prisma = {
      adminAuditLog: { findMany: jest.fn().mockResolvedValue(rows) },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'actor', nickname: '管理员小明', accountId: 'admin' },
          ]),
      },
      consoleEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return {
      prisma,
      service: new ConsoleInsightsService(
        prisma as unknown as PrismaService,
        {} as RedisService,
      ),
    };
  }
  it('resolves visible actors in one bounded lookup and never returns raw metadata', async () => {
    const { prisma, service } = setup([
      {
        id: '1',
        actorID: 'actor',
        action: 'console.request.failed',
        createdAt: at,
        metadata: { status: 503, token: 'private', route: '/internal' },
      },
      {
        id: '2',
        actorID: 'actor',
        action: 'admin.login.success',
        createdAt: at,
        metadata: { status: 500 },
      },
      {
        id: '3',
        actorID: 'off-page',
        action: 'console.request.failed',
        createdAt: at,
      },
    ]);
    const result = await service.diagnostics({
      limit: 2,
      days: 30,
      requestID: 'request',
      userID: 'actor',
    });
    expect(prisma.adminAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [FAILED_AUDIT_WHERE],
          requestId: 'request',
          actorID: 'actor',
        },
        take: 3,
      }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['actor'] } },
      select: { id: true, nickname: true, accountId: true },
    });
    expect(result.items[0]).toMatchObject({
      actor: { nickname: '管理员小明' },
      failureStatus: 503,
    });
    expect(result.items[1].failureStatus).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/private|internal|metadata/);
    expect(result.nextCursor).toContain('|2');
  });
  it.each([
    null,
    [],
    { status: '503' },
    { status: 200 },
    { status: 600 },
    { status: 500.5 },
  ])('handles legacy and invalid failure metadata: %j', async (metadata) => {
    const { service } = setup([
      {
        id: '1',
        actorID: 'missing',
        createdAt: at,
        action: 'console.request.failed',
        metadata,
      },
    ]);
    expect(
      (await service.diagnostics({ limit: 30, days: 30 })).items[0],
    ).toMatchObject({
      actor: null,
      failureStatus: null,
    });
  });
  it('skips actor lookup on an empty result', async () => {
    const { service, prisma } = setup();
    expect(await service.diagnostics({ limit: 30, days: 30 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
  it('adds only public user summary fields to paginated user behavior records', async () => {
    const { service, prisma } = setup();
    await service.events({
      limit: 20,
      days: 30,
      userID: 'user',
      name: 'APP_OPEN',
    });
    expect(prisma.consoleEvent.findMany).toHaveBeenCalledWith({
      where: { userID: 'user', name: 'APP_OPEN' },
      include: {
        user: { select: { id: true, nickname: true, accountId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
  });
});
