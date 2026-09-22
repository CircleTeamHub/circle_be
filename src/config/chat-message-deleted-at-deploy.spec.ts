import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('released ChatMessage deletedAt migration deployment safety', () => {
  const root = process.cwd();
  const releasedPath = resolve(
    root,
    'prisma/migrations/20260913001000_add_chat_message_deleted_at/migration.sql',
  );
  const scriptPath = resolve(
    root,
    'scripts/prepare-chat-message-deleted-at-migration.mjs',
  );

  it('preserves the released migration byte-for-byte', () => {
    const released = readFileSync(releasedPath, 'utf8').replace(/\r\n/g, '\n');
    expect(released).toBe(
      'ALTER TABLE "ChatMessage"\n' +
        'ADD COLUMN "deletedAt" TIMESTAMP(3);\n\n' +
        'UPDATE "ChatMessage"\n' +
        'SET "deletedAt" = CURRENT_TIMESTAMP\n' +
        'WHERE "deleted" = true;\n\n' +
        'CREATE INDEX "ChatMessage_conversationID_deletedAt_idx"\n' +
        'ON "ChatMessage"("conversationID", "deletedAt");\n',
    );
  });

  it('prepares only an existing pending deployment with committed batches and a concurrent index', () => {
    const script = readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n');
    expect(script).toContain('20260913001000_add_chat_message_deleted_at');
    expect(script).toMatch(/SELECT to_regclass\(\$1\)/);
    expect(script).toContain("tableExists(client, 'ChatMessage')");
    expect(script).toMatch(/finished_at IS NOT NULL/);
    expect(script).toMatch(
      /ALTER TABLE "ChatMessage"\s+ADD COLUMN IF NOT EXISTS "deletedAt"/,
    );
    expect(script).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(script).toMatch(/LIMIT \$1/);
    expect(script).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    expect(script).toMatch(/indisvalid/);
    expect(script).toMatch(/pg_get_indexdef/);
    expect(script).toMatch(/migrate['"],\s*['"]resolve/);

    const verifyPosition = script.indexOf('verifyPreparedSchema');
    const resolvePosition = script.lastIndexOf("'--applied'");
    expect(verifyPosition).toBeGreaterThan(-1);
    expect(resolvePosition).toBeGreaterThan(verifyPosition);
  });

  it('runs the guarded preparation immediately before bundled migrate deploy', () => {
    const compose = readFileSync(
      resolve(root, 'docker-compose.prod.yml'),
      'utf8',
    );
    expect(compose).toMatch(
      /node scripts\/prepare-chat-message-deleted-at-migration\.mjs\s*&&\s*\.\/node_modules\/\.bin\/prisma migrate deploy/,
    );
  });
});
