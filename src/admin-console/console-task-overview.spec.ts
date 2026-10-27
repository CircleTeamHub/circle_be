import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { OUTBOX_QUEUES } from 'src/metrics/outbox-depth.service';
import { ADMIN_FANOUT_MAX_CONCURRENT_QUERIES } from 'src/utils/concurrency-limit';
import { ConsoleOperationsService } from './console-operations.service';

/**
 * 任务总览(GET /console/tasks/overview)一次约 20 条查询:每个队列 pending 聚合 +
 * 死信计数,再加群操作 groupBy。以前全部同时打到 10 个连接的池上。
 */
describe('task overview', () => {
  const oldest = new Date('2026-10-20T00:00:00Z');

  function setup() {
    let active = 0;
    let peak = 0;
    const query = <T>(value: T) => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<T>((resolve) =>
        setImmediate(() => {
          active--;
          resolve(value);
        }),
      );
    };
    const delegates = Object.fromEntries(
      OUTBOX_QUEUES.map((queue) => [
        queue.model,
        {
          aggregate: jest.fn((args: { _min: Record<string, true> }) =>
            query({
              _count: { _all: 4 },
              _min: Object.fromEntries(
                Object.keys(args._min).map((field) => [field, oldest]),
              ),
            }),
          ),
          count: jest.fn(() => query(1)),
        },
      ]),
    ) as Record<
      string,
      { aggregate: jest.Mock; count: jest.Mock; groupBy?: jest.Mock }
    >;
    delegates.adminGroupOperation.groupBy = jest.fn(() =>
      query([{ status: 'FAILED', _count: 2 }]),
    );
    const service = new ConsoleOperationsService(
      delegates as unknown as PrismaService,
      new ConfigService(),
    );
    return { service, delegates, peak: () => peak };
  }

  it('keeps at most three queries in flight', async () => {
    const { service, peak } = setup();

    await service.taskOverview();

    expect(peak()).toBeLessThanOrEqual(ADMIN_FANOUT_MAX_CONCURRENT_QUERIES);
  });

  it('returns every queue with pending, dead (null when the queue has no terminal state) and oldest', async () => {
    const { service } = setup();

    const result = await service.taskOverview();

    expect(result.items).toEqual(
      OUTBOX_QUEUES.map((queue) => ({
        kind: queue.name,
        pending: 4,
        dead: queue.deadWhere ? 1 : null,
        oldestAt: oldest,
      })),
    );
    expect(result.groupOperations).toEqual([{ status: 'FAILED', _count: 2 }]);
  });

  // access_revocation 的 pendingWhere 是 (now) => where。原实现把函数原样交给 Prisma,
  // Prisma 拒绝序列化函数,整个总览接口每次都 500。口径与 collectOutboxDepths 一致:
  // 函数先用当前时间求值,最老待办按队列声明的 oldestField 算。
  it('evaluates time-dependent pending filters and uses the queue oldest field', async () => {
    const { service, delegates } = setup();

    await service.taskOverview();

    for (const queue of OUTBOX_QUEUES) {
      const [args] = delegates[queue.model].aggregate.mock.calls[0];
      expect(typeof args.where).not.toBe('function');
      expect(args._min).toEqual({ [queue.oldestField ?? 'createdAt']: true });
    }
    const [revocation] = delegates.refreshToken.aggregate.mock.calls[0];
    expect(revocation.where).toMatchObject({
      accessRevokedAt: { not: null },
      accessRevocationNotifiedAt: null,
    });
  });
});
