import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from 'src/generated/prisma';
import { NoteRecycleBinCleanup } from './note-recycle-bin.cleanup';
import { purgeDeletedNote } from './note-purge';
import { expiredRecycleBinNotesQuery } from './note-recycle-bin.query';

jest.mock('./note-purge', () => ({ purgeDeletedNote: jest.fn() }));

describe('NoteRecycleBinCleanup', () => {
  const purge = jest.mocked(purgeDeletedNote);

  type Row = { id: string; updatedAt: Date };

  function createHarness(pages: Row[][]) {
    const prisma = {
      $queryRaw: jest.fn(),
    };
    for (const page of pages) prisma.$queryRaw.mockResolvedValueOnce(page);
    prisma.$queryRaw.mockResolvedValue([]);
    const cleanup = new NoteRecycleBinCleanup(prisma as never);
    return { prisma, cleanup };
  }

  const batchQueries = (prisma: { $queryRaw: jest.Mock }) =>
    prisma.$queryRaw.mock.calls.map(([query]) => query as Prisma.Sql);

  beforeEach(() => {
    purge.mockReset();
    purge.mockResolvedValue(true);
  });

  it('purges only recycle-bin (DELETED) notes past the 30-day retention, row by row', async () => {
    const deletedAt = new Date('2026-07-01T00:00:00.000Z');
    const { prisma, cleanup } = createHarness([
      [
        { id: 'a', updatedAt: deletedAt },
        { id: 'b', updatedAt: deletedAt },
      ],
    ]);

    await cleanup.sweep(new Date('2026-08-16T04:00:00.000Z'));

    const cutoff = new Date('2026-07-17T04:00:00.000Z');
    // 下架（UNLISTED）永不进 where —— 用户拍板：下架是长期仓库，只有回收站到期删。
    // 批次查询就是导出的构造器本身（真库回归在 test/postgres 里跑同一个构造器）。
    expect(batchQueries(prisma)).toEqual([
      expiredRecycleBinNotesQuery({ cutoff, limit: 200 }),
    ]);
    // 逐行走共用的永久删除（含收录链改指向），删除时再按同一截止时间复核。
    expect(purge.mock.calls.map(([, id, guard]) => [id, guard])).toEqual([
      ['a', { deletedBefore: cutoff }],
      ['b', { deletedBefore: cutoff }],
    ]);
  });

  it('pages by an (updatedAt, id) keyset and skips a row that fails instead of retrying it forever', async () => {
    const base = Date.UTC(2026, 5, 1);
    const full = Array.from({ length: 200 }, (_, index) => ({
      id: `n${String(index).padStart(3, '0')}`,
      // 同一时刻删的成批笔记 updatedAt 相同 —— 键集靠 id 决出先后。
      updatedAt: new Date(base + Math.floor(index / 50) * 1000),
    }));
    const { prisma, cleanup } = createHarness([
      full,
      [{ id: 'a-later', updatedAt: new Date(base + 10_000) }],
    ]);
    purge.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'P2010' }),
    );

    const now = new Date('2026-08-16T04:00:00.000Z');
    await expect(cleanup.sweep(now)).resolves.toBeUndefined();

    expect(purge).toHaveBeenCalledTimes(201);
    const cutoff = new Date('2026-07-17T04:00:00.000Z');
    expect(batchQueries(prisma)).toEqual([
      expiredRecycleBinNotesQuery({ cutoff, limit: 200 }),
      expiredRecycleBinNotesQuery({
        cutoff,
        after: { updatedAt: full[199].updatedAt, id: 'n199' },
        limit: 200,
      }),
    ]);
  });

  it('swallows database failures so the daily cron can retry tomorrow', async () => {
    const { prisma, cleanup } = createHarness([]);
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));

    await expect(cleanup.sweep()).resolves.toBeUndefined();
  });

  it('ships with the retention baseline migration for pre-existing deleted rows', () => {
    // 30 天保留期是本分支首次引入,而清理按 updatedAt 判龄:没有基线迁移的话,
    // 上线后第一次扫描会追溯硬删用户几个月前(旧契约=永久可恢复)删的存量笔记。
    // 这里守住"清理任务与基线迁移必须一起出现",防止未来有人单独 revert 迁移。
    const sql = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260816080000_recycle_bin_retention_baseline/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toMatch(/UPDATE "Note" SET "updatedAt" = NOW\(\)/);
    expect(sql).toMatch(/WHERE "status" = 'DELETED'/);
  });
});
