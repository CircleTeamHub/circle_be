import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

type OutboxKind = 'friend' | 'group';
type OutboxSummary = {
  pending: number;
  processing: number;
  failed: number;
  oldestPendingAt: Date | null;
  oldestFailedAt: Date | null;
};

type GroupRow = {
  status: string;
  _count: { _all: number };
};

type OutboxModel = {
  groupBy: (args: any) => Promise<GroupRow[]>;
  findFirst: (args: any) => Promise<{ createdAt: Date } | null>;
};

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async getHealth(): Promise<Record<OutboxKind, OutboxSummary>> {
    const [friend, group] = await Promise.all([
      this.summarize(this.prisma.friendSyncOutbox as unknown as OutboxModel),
      this.summarize(this.prisma.groupSyncOutbox as unknown as OutboxModel),
    ]);

    return { friend, group };
  }

  private async summarize(model: OutboxModel): Promise<OutboxSummary> {
    const [counts, oldestPending, oldestFailed] = await Promise.all([
      model.groupBy({
        by: ['status'],
        where: { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
        _count: { _all: true },
      }),
      this.findOldest(model, 'PENDING'),
      this.findOldest(model, 'FAILED'),
    ]);

    const byStatus = new Map(
      counts.map((row) => [row.status, row._count._all] as const),
    );
    return {
      pending: byStatus.get('PENDING') ?? 0,
      processing: byStatus.get('PROCESSING') ?? 0,
      failed: byStatus.get('FAILED') ?? 0,
      oldestPendingAt: oldestPending?.createdAt ?? null,
      oldestFailedAt: oldestFailed?.createdAt ?? null,
    };
  }

  private findOldest(
    model: OutboxModel,
    status: 'PENDING' | 'FAILED',
  ): Promise<{ createdAt: Date } | null> {
    return model.findFirst({
      where: { status },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
  }
}
