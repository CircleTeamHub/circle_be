import { ConfigService } from '@nestjs/config';
import { ConsoleOperationsService } from './console-operations.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('task detail enrichment', () => {
  const at = new Date('2026-10-17T00:00:00Z');
  const row = {
    id: 'task-1',
    status: 'COMPLETED',
    attempts: 1,
    createdAt: at,
    updatedAt: at,
    nextAttemptAt: at,
    lastError: null,
  };
  function setup(rows = [row]) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      notificationPushOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            notification: {
              type: 'SYSTEM',
              toUserID: 'user-1',
              toUser: { id: 'user-1', nickname: '测试用户' },
            },
          },
        ]),
      },
      notificationPushDelivery: {
        groupBy: jest.fn().mockResolvedValue([
          { outboxID: 'task-1', status: 'SENT', _count: { _all: 2 } },
          { outboxID: 'task-1', status: 'TERMINAL', _count: { _all: 1 } },
        ]),
      },
    };
    return {
      prisma,
      service: new ConsoleOperationsService(
        prisma as unknown as PrismaService,
        new ConfigService(),
      ),
    };
  }
  it('adds type, recipient and aggregated delivery states for only the visible page', async () => {
    const { prisma, service } = setup([row, { ...row, id: 'next-page' }]);
    const result = await service.tasks({ limit: 1, days: 30 });
    expect(result.items[0]).toMatchObject({
      notification: { type: 'SYSTEM', toUserID: 'user-1' },
      deliveryCounts: { SENT: 2, TERMINAL: 1 },
      nextAttemptAt: null,
    });
    expect(
      prisma.notificationPushOutbox.findMany.mock.calls[0][0].where.id.in,
    ).toEqual(['task-1']);
    expect(
      prisma.notificationPushOutbox.findMany.mock.calls[0][0].select,
    ).not.toHaveProperty('payload');
    expect(
      prisma.notificationPushOutbox.findMany.mock.calls[0][0].select
        .notification.select,
    ).not.toHaveProperty('content');
    expect(result.nextCursor).not.toBeNull();
  });
  it('keeps failed retry schedules and handles unavailable notification records', async () => {
    const { prisma, service } = setup([{ ...row, status: 'FAILED' }]);
    prisma.notificationPushOutbox.findMany.mockResolvedValue([]);
    prisma.notificationPushDelivery.groupBy.mockResolvedValue([]);
    expect(
      (await service.tasks({ limit: 20, days: 30 })).items[0],
    ).toMatchObject({
      nextAttemptAt: at,
      notification: null,
      deliveryCounts: {},
      retryable: true,
    });
  });
  it('does not query notification details for other queues or empty pages', async () => {
    const { prisma, service } = setup();
    await service.tasks({ limit: 20, days: 30, kind: 'group_operation' });
    expect(prisma.notificationPushOutbox.findMany).not.toHaveBeenCalled();
    prisma.$queryRaw.mockResolvedValue([]);
    await service.tasks({ limit: 20, days: 30 });
    expect(prisma.notificationPushDelivery.groupBy).not.toHaveBeenCalled();
  });
});

it('exposes stored completion reason without guessing historical causes', async () => {
  const at = new Date('2026-10-17');
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'reason',
        status: 'COMPLETED',
        createdAt: at,
        updatedAt: at,
        attempts: 1,
        nextAttemptAt: at,
        lastError: null,
      },
    ]),
    notificationPushOutbox: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'reason',
          notification: null,
          completionReason: 'NO_ACTIVE_DEVICE',
        },
      ]),
    },
    notificationPushDelivery: { groupBy: jest.fn().mockResolvedValue([]) },
  };
  const service = new ConsoleOperationsService(
    prisma as unknown as PrismaService,
    new ConfigService(),
  );
  expect(
    (await service.tasks({ limit: 20, days: 30 })).items[0].completionReason,
  ).toBe('NO_ACTIVE_DEVICE');
  prisma.notificationPushOutbox.findMany.mockResolvedValue([
    { id: 'reason', notification: null, completionReason: null },
  ]);
  expect(
    (await service.tasks({ limit: 20, days: 30 })).items[0].completionReason,
  ).toBeNull();
});
