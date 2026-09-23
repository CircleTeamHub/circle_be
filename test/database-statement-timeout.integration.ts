import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { resolveDatabasePoolConfig } from '../src/prisma/prisma.service';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(
    connectionString,
    'DATABASE_URL is required for this integration gate',
  );

  const pool = new Pool({
    connectionString,
    ...resolveDatabasePoolConfig({ DATABASE_STATEMENT_TIMEOUT_MS: '75' }),
  });
  try {
    const timeout = await pool.query<{ statement_timeout: string }>(
      'SHOW statement_timeout',
    );
    assert.equal(timeout.rows[0]?.statement_timeout, '75ms');

    await assert.rejects(
      pool.query('SELECT pg_sleep(0.2)'),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === '57014',
      'PostgreSQL must cancel a statement that exceeds the configured budget',
    );
  } finally {
    await pool.end();
  }
}

void main();
