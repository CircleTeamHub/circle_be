import { NotificationRetentionCleanup } from './notification-retention.cleanup';

type RetentionConfig = Partial<
  Record<
    'NOTIFICATION_RETENTION_DAYS' | 'FRIEND_ACTIVITY_RETENTION_DAYS',
    number
  >
>;

function buildHarness(
  configValues: RetentionConfig = {},
  executeRaw = jest.fn<Promise<number>, unknown[]>().mockResolvedValue(0),
) {
  const transactionClient = {
    $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
    $executeRaw: executeRaw,
  };
  const prisma = {
    $executeRaw: executeRaw,
    $transaction: jest.fn(
      async (callback: (tx: typeof transactionClient) => Promise<void>) =>
        callback(transactionClient),
    ),
  };
  const config = {
    get: jest.fn((key: keyof RetentionConfig) => configValues[key]),
  };

  return {
    cleanup: new NotificationRetentionCleanup(prisma as any, config as any),
    executeRaw,
    prisma,
  };
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join(' ');
}

describe('NotificationRetentionCleanup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('commits each delete statement independently instead of wrapping the sweep in one transaction', async () => {
    const { cleanup, executeRaw, prisma } = buildHarness();

    await cleanup.sweep(new Date('2026-07-22T12:00:00.000Z'));

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('claims an indexed batch with SKIP LOCKED so replicas can clean concurrently', async () => {
    const { cleanup, executeRaw } = buildHarness({
      NOTIFICATION_RETENTION_DAYS: 90,
      FRIEND_ACTIVITY_RETENTION_DAYS: 0,
    });

    await cleanup.sweep(new Date('2026-07-22T12:00:00.000Z'));

    const call = executeRaw.mock.calls[0];
    expect(sqlText(call)).toContain('ORDER BY "createdAt"');
    expect(sqlText(call)).toContain('FOR UPDATE SKIP LOCKED');
    expect(call.slice(1)).toContain(1_000);
  });

  it('stops a table sweep when its time budget is exhausted', async () => {
    const executeRaw = jest
      .fn<Promise<number>, unknown[]>()
      .mockResolvedValue(5_000);
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValue(15_000);
    const { cleanup } = buildHarness(
      {
        NOTIFICATION_RETENTION_DAYS: 90,
        FRIEND_ACTIVITY_RETENTION_DAYS: 0,
      },
      executeRaw,
    );

    await cleanup.sweep(new Date('2026-07-22T12:00:00.000Z'));

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('backs off between full batches before continuing', async () => {
    const executeRaw = jest
      .fn<Promise<number>, unknown[]>()
      .mockResolvedValueOnce(1_000)
      .mockResolvedValueOnce(0);
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      callback();
      return {} as NodeJS.Timeout;
    }) as typeof setTimeout);
    const { cleanup } = buildHarness(
      {
        NOTIFICATION_RETENTION_DAYS: 90,
        FRIEND_ACTIVITY_RETENTION_DAYS: 0,
      },
      executeRaw,
    );

    await cleanup.sweep(new Date('2026-07-22T12:00:00.000Z'));

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
  });
});
