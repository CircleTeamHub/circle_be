import { readFileSync } from 'node:fs';

// 文字加密停用(第一阶段):已经开了加密的会话改回明文,但这一步必须能撤回 ——
// E2ee* 表与 textEncryption 列都留到第二阶段才删,回滚靠 E2eeRoom 找回原来的会话。
describe('text encryption switch-off migration', () => {
  const migration = readFileSync(
    'prisma/migrations/20261025000000_text_encryption_off/migration.sql',
    'utf8',
  );
  const statements = migration
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('moves only encrypted conversations back to plain text', () => {
    expect(statements).toMatch(
      /UPDATE "ChatConversation"\s+SET "textEncryption" = 'PLAIN'\s+WHERE "textEncryption" = 'MLS_V1';/,
    );
  });

  it('keeps every table and column the rollback and stage two need', () => {
    expect(statements).not.toMatch(/\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toMatch(/textEncryption\s+String\s+@default\("PLAIN"\)/);
    for (const model of [
      'E2eeDevice',
      'E2eeKeyPackage',
      'E2eeRoom',
      'E2eeRoomDevice',
      'E2eeEpochEvent',
      'E2eeRecovery',
      'E2eeArchive',
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it('documents how to restore the encrypted mode from E2eeRoom', () => {
    expect(migration).toMatch(
      /--\s*UPDATE "ChatConversation" c SET "textEncryption" = 'MLS_V1' FROM "E2eeRoom" r WHERE r\."conversationID" = c\."id";/,
    );
  });
});
