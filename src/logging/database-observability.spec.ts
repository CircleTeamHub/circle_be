import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { observeDatabaseAdapter } from './database-observability';
import { runWithRequestContext } from './request-context';
import { runWithOperationContext } from './operation-context';

describe('database operation timing', () => {
  const logger = { warn: jest.fn() } as unknown as Logger;
  const config = { performanceLogOn: true, slowDbOperationMs: 1000 };
  const secretQuery = {
    sql: "SELECT * FROM private_messages WHERE token = 'sql-secret'",
    args: ['private-param'],
    argTypes: [],
  };

  function fixture() {
    const rows = {
      columnNames: ['token'],
      columnTypes: [7],
      rows: [['secret-result']],
    };
    const transaction = {
      provider: 'postgres',
      adapterName: 'test',
      options: { usePhantomQuery: true },
      queryRaw: jest.fn().mockResolvedValue(rows),
      executeRaw: jest.fn().mockResolvedValue(1),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };
    const adapter = {
      provider: 'postgres',
      adapterName: 'test',
      queryRaw: jest.fn().mockResolvedValue(rows),
      executeRaw: jest.fn().mockResolvedValue(1),
      startTransaction: jest.fn().mockResolvedValue(transaction),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const factory = {
      provider: 'postgres',
      adapterName: 'test',
      connect: jest.fn().mockResolvedValue(adapter),
    };
    return { rows, transaction, adapter, factory };
  }

  beforeEach(() => (logger.warn as jest.Mock).mockReset());

  it('logs only a fixed operation, duration, outcome and correlation for a slow driver call', async () => {
    const { factory, rows, adapter } = fixture();
    const originalQuery = adapter.queryRaw;
    const elapsed = jest.fn().mockReturnValueOnce(10).mockReturnValueOnce(1010);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
    );
    expect(observed).toBe(factory);

    const connected = await observed.connect();
    await runWithRequestContext(
      {
        requestId: 'request-1',
        traceId: 'trace-1',
        method: 'POST',
        path: '/private',
      },
      async () => {
        await expect(connected.queryRaw(secretQuery)).resolves.toBe(rows);
      },
    );

    expect(originalQuery).toHaveBeenCalledTimes(1);
    expect(originalQuery).toHaveBeenCalledWith(secretQuery);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: 'database_operation_slow',
        scope: 'driver_adapter',
        operation: 'queryRaw',
        durationMs: 1000,
        thresholdMs: 1000,
        result: 'success',
        suppressedCount: 0,
        requestId: 'request-1',
        traceId: 'trace-1',
      },
      'Performance',
    );
    const output = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    for (const secret of [
      'SELECT',
      'private_messages',
      'sql-secret',
      'private-param',
      'secret-result',
      '/private',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('preserves the driver error without adding its message or metadata to logs', async () => {
    const { factory, adapter } = fixture();
    const original = Object.assign(new Error('sensitive SQL and password'), {
      code: 'private-code',
    });
    adapter.executeRaw.mockRejectedValueOnce(original);
    const elapsed = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(1500);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
    );

    await expect(
      (await observed.connect()).executeRaw(secretQuery),
    ).rejects.toBe(original);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'executeRaw',
        result: 'failure',
        durationMs: 1500,
      }),
      'Performance',
    );
    const output = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(output).not.toContain('sensitive');
    expect(output).not.toContain('private-code');
  });

  it('bounds burst warnings independently for successes and failures', async () => {
    const { factory, adapter } = fixture();
    const original = new Error('private outage');
    adapter.executeRaw.mockRejectedValue(original);
    const elapsed = jest.fn();
    for (let index = 0; index < 12; index += 1) {
      elapsed
        .mockReturnValueOnce(index * 2000)
        .mockReturnValueOnce(index * 2000 + 1500);
    }
    const warningClock = jest
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(4)
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(6)
      .mockReturnValueOnce(7)
      .mockReturnValueOnce(8)
      .mockReturnValueOnce(9)
      .mockReturnValueOnce(60_001)
      .mockReturnValueOnce(60_002);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
      warningClock,
    );
    const connection = await observed.connect();

    for (let index = 0; index < 6; index += 1) {
      await connection.queryRaw(secretQuery);
      await expect(connection.executeRaw(secretQuery)).rejects.toBe(original);
    }

    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toMatchObject({
      operation: 'queryRaw',
      result: 'success',
      suppressedCount: 0,
    });
    expect((logger.warn as jest.Mock).mock.calls[1][0]).toMatchObject({
      operation: 'executeRaw',
      result: 'failure',
      suppressedCount: 0,
    });
    expect((logger.warn as jest.Mock).mock.calls[2][0]).toMatchObject({
      operation: 'queryRaw',
      result: 'success',
      suppressedCount: 4,
    });
    expect((logger.warn as jest.Mock).mock.calls[3][0]).toMatchObject({
      operation: 'executeRaw',
      result: 'failure',
      suppressedCount: 4,
    });
  });

  it('retains transaction methods and options while timing their queries', async () => {
    const { factory, adapter, transaction, rows } = fixture();
    const originalQuery = transaction.queryRaw;
    const startTransaction = adapter.startTransaction;
    const commit = transaction.commit;
    const rollback = transaction.rollback;
    const elapsed = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(2000);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
    );
    const connection = await observed.connect();
    const tx = await connection.startTransaction('SERIALIZABLE');

    expect(tx).toBe(transaction);
    expect(startTransaction).toHaveBeenCalledWith('SERIALIZABLE');
    expect(tx.commit).toBe(commit);
    expect(tx.rollback).toBe(rollback);
    expect(tx.options).toEqual({ usePhantomQuery: true });
    await expect(tx.queryRaw(secretQuery)).resolves.toBe(rows);
    expect(originalQuery).toHaveBeenCalledWith(secretQuery);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'queryRaw', durationMs: 2000 }),
      'Performance',
    );
  });

  it('does not wrap anything when performance logging is disabled', () => {
    const { factory } = fixture();
    const connect = factory.connect;
    const elapsed = jest.fn();
    observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      { ...config, performanceLogOn: false },
      elapsed,
    );
    expect(factory.connect).toBe(connect);
    expect(elapsed).not.toHaveBeenCalled();
  });

  it('does not emit a log below the threshold', async () => {
    const { factory } = fixture();
    const elapsed = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(999);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
    );
    await (await observed.connect()).queryRaw(secretQuery);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps job correlation on a slow transaction operation', async () => {
    const { factory } = fixture();
    const elapsed = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(1000);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
    );
    const connection = await observed.connect();
    await runWithOperationContext(
      { job: 'sweeper', runId: 'run-1' },
      async () => {
        const tx = await connection.startTransaction();
        await tx.queryRaw(secretQuery);
      },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        job: 'sweeper',
        runId: 'run-1',
        operation: 'queryRaw',
      }),
      'Performance',
    );
  });

  it('preserves both results and original errors if the logger throws', async () => {
    const { factory, adapter, rows } = fixture();
    const original = new Error('original failure');
    adapter.executeRaw.mockRejectedValueOnce(original);
    (logger.warn as jest.Mock).mockImplementation(() => {
      throw new Error('logging failed');
    });
    const elapsed = jest
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(3000);
    const observed = observeDatabaseAdapter(
      factory as unknown as PrismaPg,
      logger,
      config,
      elapsed,
    );
    const connection = await observed.connect();
    await expect(connection.queryRaw(secretQuery)).resolves.toBe(rows);
    await expect(connection.executeRaw(secretQuery)).rejects.toBe(original);
  });
});
