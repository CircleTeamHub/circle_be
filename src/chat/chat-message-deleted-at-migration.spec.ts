import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

describe('chat message deletedAt migration history', () => {
  it('preserves the released migration including its tombstone backfill and index', () => {
    const sql = readFileSync(
      'prisma/migrations/20260913001000_add_chat_message_deleted_at/migration.sql',
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      '808348ad0863431e5e6b8d4c44cc4f88c674689a3f79aefc4bd68e843b8ea05b',
    );
  });

  it('does not introduce a redundant concurrent index migration with an unsafe retry', () => {
    expect(
      existsSync(
        'prisma/migrations/20260913001100_index_chat_message_deleted_at/migration.sql',
      ),
    ).toBe(false);
  });
});
