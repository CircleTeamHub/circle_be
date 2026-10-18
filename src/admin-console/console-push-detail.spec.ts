import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConsoleQuery } from './console.dto';
import { ConsoleOperationsService } from './console-operations.service';

describe('push task detail lookup', () => {
  it('filters by exact task ID before pagination and returns authoritative delivery totals', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const prisma = {
      notificationPushOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id,
            createdAt: new Date(),
            deliveries: [],
            completionReason: 'NO_ACTIVE_DEVICE',
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      notificationPushDelivery: {
        groupBy: jest
          .fn()
          .mockResolvedValue([
            { outboxID: id, status: 'SENT', _count: { _all: 123 } },
          ]),
      },
    };
    const service = new ConsoleOperationsService(
      prisma as unknown as PrismaService,
      new ConfigService(),
    );
    const result = await service.pushes({ taskID: id, limit: 30, days: 30 });
    expect(prisma.notificationPushOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id }, take: 31 }),
    );
    expect(result.items[0]).toMatchObject({
      id,
      completionReason: 'NO_ACTIVE_DEVICE',
      deliveryCounts: { SENT: 123 },
    });
    expect(prisma.notificationPushDelivery.groupBy).toHaveBeenCalledWith({
      by: ['outboxID', 'status'],
      where: { outboxID: { in: [id] } },
      _count: { _all: true },
    });
  });
  it('validates task IDs rather than accepting arbitrary filters', () => {
    expect(
      validateSync(
        plainToInstance(ConsoleQuery, { taskID: 'not-a-uuid' }),
      ).some((e) => e.property === 'taskID'),
    ).toBe(true);
    expect(
      validateSync(
        plainToInstance(ConsoleQuery, {
          taskID: '11111111-1111-4111-8111-111111111111',
        }),
      ),
    ).toHaveLength(0);
  });
});
