import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from 'src/generated/prisma';
import { observeDatabaseAdapter } from 'src/logging/database-observability';

/** Real Prisma client and pg adapter; only the network boundary is replaced. */
describe('database observability with Prisma transactions', () => {
  function fixture() {
    const statements: string[] = [];
    const execute = jest.fn(async (query: { text: string }) => {
      statements.push(query.text);
      return {
        command: 'SELECT',
        rowCount: 1,
        rows: [[1]],
        fields: [{ name: 'value', dataTypeID: 23 }],
      };
    });
    const pool = new Pool({
      connectionString: 'postgresql://test@localhost/test',
    });
    pool.query = execute as unknown as Pool['query'];
    const connection = {
      query: execute,
      on: jest.fn(),
      removeListener: jest.fn(),
      release: jest.fn(),
    };
    pool.connect = jest.fn(
      async () => connection,
    ) as unknown as Pool['connect'];
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let elapsed = 0;
    const client = new PrismaClient({
      adapter: observeDatabaseAdapter(
        new PrismaPg(pool),
        logger,
        { performanceLogOn: true, slowDbOperationMs: 1 },
        () => elapsed++,
      ),
    });
    return { client, pool, statements, connection, logger };
  }

  it('preserves lazy batch queries and commits them on one transaction connection', async () => {
    const { client, pool, statements, connection, logger } = fixture();
    try {
      const first = client.$queryRaw`SELECT 1 AS value`;
      const second = client.$queryRaw`SELECT 1 AS value`;
      expect(statements).toEqual([]);
      await expect(client.$transaction([first, second])).resolves.toEqual([
        [{ value: 1 }],
        [{ value: 1 }],
      ]);
      expect(statements).toEqual([
        'BEGIN',
        'SELECT 1 AS value',
        'SELECT 1 AS value',
        'COMMIT',
      ]);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(connection.release).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'database_operation_slow',
          operation: 'queryRaw',
        }),
        'Performance',
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SELECT');
    } finally {
      await client.$disconnect();
      await pool.end();
    }
  });

  it('preserves interactive transaction rollback and the original thrown error', async () => {
    const { client, pool, statements, connection, logger } = fixture();
    const original = new Error('business failure');
    logger.warn.mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    try {
      await expect(
        client.$transaction(async (tx) => {
          await expect(tx.$queryRaw`SELECT 1 AS value`).resolves.toEqual([
            { value: 1 },
          ]);
          throw original;
        }),
      ).rejects.toBe(original);
      expect(statements).toEqual(['BEGIN', 'SELECT 1 AS value', 'ROLLBACK']);
      expect(connection.release).toHaveBeenCalledTimes(1);
    } finally {
      await client.$disconnect();
      await pool.end();
    }
  });
});
