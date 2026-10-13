import { readFileSync } from 'fs';
import { join } from 'path';
import {
  NOTE_CONTENT_JSON_REPAIR_STATEMENTS,
  NoteContentJsonRepair,
} from './note-content-json-repair';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('NoteContentJsonRepair', () => {
  function createHarness() {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const repair = new NoteContentJsonRepair(prisma as never);
    return { prisma, repair };
  }

  it('runs exactly the statements of the repair migration (no drift between the two copies)', () => {
    // 迁移负责存量，定时任务负责切流前旧版本漏写的行：两边必须是同一组语句，
    // 改了一边忘了另一边，这里就红。
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261013000000_repair_wiped_note_content_json/migration.sql',
      ),
      'utf8',
    );
    const migrationStatements = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(normalize)
      .filter(Boolean);

    // 无插值：没有任何参数，文本就是要执行的完整语句。
    for (const statement of NOTE_CONTENT_JSON_REPAIR_STATEMENTS) {
      expect(statement.values).toEqual([]);
    }
    expect(
      NOTE_CONTENT_JSON_REPAIR_STATEMENTS.map((statement) =>
        normalize(statement.sql),
      ),
    ).toEqual(migrationStatements);
  });

  it('re-runs every repair statement on each sweep', async () => {
    const { prisma, repair } = createHarness();
    prisma.$executeRaw.mockResolvedValueOnce(2);

    await repair.sweep();

    expect(prisma.$executeRaw.mock.calls.map(([sql]) => sql)).toEqual(
      NOTE_CONTENT_JSON_REPAIR_STATEMENTS,
    );
  });

  it('swallows database failures so the next hourly run can retry', async () => {
    const { prisma, repair } = createHarness();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));

    await expect(repair.sweep()).resolves.toBeUndefined();
  });
});
