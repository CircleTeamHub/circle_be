import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

function allowlistedTestDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Account-identifier integration requires NODE_ENV=test');
  }
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) {
    throw new Error(
      `Refusing account-identifier integration on non-test database: ${databaseName}`,
    );
  }
  return databaseUrl;
}

const databaseUrl = allowlistedTestDatabaseUrl();
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('account identifier trigger PostgreSQL integration', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl! });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it('supports two successive account-ID changes and cleans released rows afterwards', async () => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const userId = randomUUID();
    const first = `a${suffix}`;
    const second = `b${suffix}`;
    const third = `c${suffix}`;
    const inviteCode = `i${suffix}`;

    await client.query('BEGIN');
    try {
      await client.query(
        `
          INSERT INTO "User" (
            "id", "accountId", "inviteCode", "passwordHash", "nickname",
            "createdAt", "updatedAt"
          )
          VALUES (
            $1, $2, $3, 'test-password-hash', 'Trigger Test',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `,
        [userId, first, inviteCode],
      );
      await client.query('UPDATE "User" SET "accountId" = $1 WHERE "id" = $2', [
        second,
        userId,
      ]);
      await client.query('UPDATE "User" SET "accountId" = $1 WHERE "id" = $2', [
        third,
        userId,
      ]);

      const user = await client.query<{ accountId: string }>(
        'SELECT "accountId" FROM "User" WHERE "id" = $1',
        [userId],
      );
      const released = await client.query<{ value: string }>(
        `
          SELECT "value"
          FROM "AccountIdentifier"
          WHERE "value" = ANY($1::text[])
          ORDER BY "value"
        `,
        [[first, second]],
      );

      expect(user.rows[0]?.accountId).toBe(third);
      expect(released.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
