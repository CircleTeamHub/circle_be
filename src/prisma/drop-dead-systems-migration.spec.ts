import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../prisma/migrations/20260625130000_drop_dead_systems/migration.sql',
);

describe('drop dead systems migration', () => {
  const sql = readFileSync(MIGRATION_SQL_PATH, 'utf8');

  it('aborts before dropping dead tables when any table still contains data', () => {
    expect(sql).toContain('dead system table "%" is not empty');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('SELECT count(*) FROM %s');
  });

  it('aborts before dropping Notification.squadRequestID when live rows still reference squad requests', () => {
    expect(sql).toContain('"Notification"."squadRequestID" still has % rows');
    expect(sql).toContain('"squadRequestID" IS NOT NULL');
  });
});
