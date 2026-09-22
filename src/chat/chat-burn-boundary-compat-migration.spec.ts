import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('mixed-version chat burn boundary compatibility', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260921010000_sync_chat_burn_boundary_for_legacy_writers/migration.sql',
  );

  it('installs a write-side trigger without rewriting the released migration', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
    const released = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20260914010000_add_chat_burn_started_at/migration.sql',
      ),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE OF "burnDurationSec", "burnStartedAt"/,
    );
    expect(sql).toMatch(/COALESCE\(NEW\."burnDurationSec", 0\) <= 0/);
    expect(sql).toMatch(/NEW\."burnStartedAt" := NULL/);
    expect(sql).toMatch(/COALESCE\(OLD\."burnDurationSec", 0\) <= 0/);
    expect(sql).toMatch(
      /NEW\."burnStartedAt" IS NOT DISTINCT FROM OLD\."burnStartedAt"/,
    );
    expect(sql).toMatch(/NEW\."burnStartedAt" := CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/WHERE COALESCE\("burnDurationSec", 0\) <= 0/);
    expect(released).toBe(
      'ALTER TABLE "ChatConversation"\n' +
        'ADD COLUMN "burnStartedAt" TIMESTAMP(3);\n\n' +
        '-- Existing enabled conversations predate a durable activation boundary. Treat\n' +
        '-- deployment as the start so historical messages are never retroactively lost.\n' +
        'UPDATE "ChatConversation"\n' +
        'SET "burnStartedAt" = CURRENT_TIMESTAMP\n' +
        'WHERE "burnDurationSec" IS NOT NULL;\n',
    );
  });
});
