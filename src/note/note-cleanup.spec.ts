import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from 'src/generated/prisma';
import { NoteCleanup } from './note-cleanup';
import {
  expiredRecycleBinNotesQuery,
  expiredUnlistedNotesQuery,
  type NoteCleanupRow,
} from './note-cleanup.query';
import { purgeDeletedNote } from './note-purge';
import {
  NOTE_RECYCLE_BIN_RETENTION_MS,
  NOTE_UNLISTED_RETENTION_MS,
} from './note.service';

jest.mock('./note-purge', () => ({ purgeDeletedNote: jest.fn() }));

/**
 * 候选查询的口径（回收站满 30 天 / 下架满 60 天、键集不重不漏、走部分索引）在真库
 * test/postgres/note-cleanup.pg-spec.ts 里跑；这里守任务的编排：到期的下架笔记标 DELETED
 * 后当场删行（不进回收站），回收站里满 30 天的按同一截止时间复核后删行，单行失败跳过、
 * 整轮失败吞掉等下一轮。
 */
describe('NoteCleanup', () => {
  const purge = jest.mocked(purgeDeletedNote);
  const now = new Date('2026-11-13T12:00:00.000Z');
  const unlistedBefore = new Date('2026-09-14T12:00:00.000Z');
  const deletedBefore = new Date('2026-10-14T12:00:00.000Z');

  const row = (
    id: string,
    at = '2026-01-01T00:00:00.000Z',
  ): NoteCleanupRow => ({
    id,
    ownerID: `owner-of-${id}`,
    rootSourceNoteID: null,
    cursorAt: new Date(at),
  });

  function createHarness(pages: {
    expired?: NoteCleanupRow[][];
    deleted?: NoteCleanupRow[][];
  }) {
    const expiredPages = [...(pages.expired ?? [])];
    const deletedPages = [...(pages.deleted ?? [])];
    const prisma = {
      $queryRaw: jest.fn(
        async (query: Prisma.Sql) =>
          (query.sql.includes(`"status" = 'UNLISTED'`)
            ? expiredPages
            : deletedPages
          ).shift() ?? [],
      ),
    };
    const notes = { expireUnlistedNote: jest.fn().mockResolvedValue(true) };
    const cleanup = new NoteCleanup(prisma as never, notes as never);
    return { prisma, notes, cleanup };
  }
  const queries = (prisma: { $queryRaw: jest.Mock }) =>
    prisma.$queryRaw.mock.calls.map(([query]) => query as Prisma.Sql);

  beforeEach(() => {
    purge.mockReset();
    purge.mockResolvedValue(true);
  });

  it('uses absolute 60 × 24h (下架) and 30 × 24h (回收站) windows', () => {
    expect(NOTE_UNLISTED_RETENTION_MS).toBe(60 * 24 * 60 * 60 * 1000);
    expect(now.getTime() - unlistedBefore.getTime()).toBe(
      NOTE_UNLISTED_RETENTION_MS,
    );
    expect(NOTE_RECYCLE_BIN_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(now.getTime() - deletedBefore.getTime()).toBe(
      NOTE_RECYCLE_BIN_RETENTION_MS,
    );
  });

  it('purges expired 下架 notes on the spot, then recycle-bin notes past 30 days', async () => {
    const { prisma, notes, cleanup } = createHarness({
      expired: [[row('old-unlisted')]],
      deleted: [[row('deleted-long-ago')]],
    });
    const order: string[] = [];
    notes.expireUnlistedNote.mockImplementation(async (note) => {
      order.push(`expire:${note.id}`);
      return true;
    });
    purge.mockImplementation(async (_prisma, id) => {
      order.push(`purge:${id}`);
      return true;
    });

    await cleanup.sweep(now);

    // 回收站只取删除满 30 天的：刚删的留在回收站里等主人恢复。
    expect(queries(prisma)).toEqual([
      expiredUnlistedNotesQuery({ unlistedBefore, limit: 200 }),
      expiredRecycleBinNotesQuery({ deletedBefore, limit: 200 }),
    ]);
    // 到期判定在写入时按同一截止时间复核（被重新上架的不动）。
    expect(notes.expireUnlistedNote).toHaveBeenCalledWith(
      row('old-unlisted'),
      unlistedBefore,
    );
    expect(order).toEqual([
      'expire:old-unlisted',
      'purge:old-unlisted',
      'purge:deleted-long-ago',
    ]);
    // 下架到期不进回收站：以主人的名义当场删；回收站的删除时再按截止时间复核。
    expect(purge.mock.calls.map(([, id, guard]) => [id, guard])).toEqual([
      ['old-unlisted', { ownerID: 'owner-of-old-unlisted' }],
      ['deleted-long-ago', { deletedBefore }],
    ]);
  });

  it('does not purge a 下架 note that was relisted before it could be expired', async () => {
    const { notes, cleanup } = createHarness({
      expired: [[row('relisted')]],
    });
    notes.expireUnlistedNote.mockResolvedValueOnce(false);

    await cleanup.sweep(now);

    expect(purge).not.toHaveBeenCalled();
  });

  it('pages by a (time, id) keyset and skips a row that fails instead of retrying it forever', async () => {
    const full = Array.from({ length: 200 }, (_, index) =>
      row(`n${String(index).padStart(3, '0')}`),
    );
    const { prisma, cleanup } = createHarness({
      deleted: [full, [row('later', '2026-02-01T00:00:00.000Z')]],
    });
    purge.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'P2010' }),
    );

    await expect(cleanup.sweep(now)).resolves.toBeUndefined();

    expect(purge).toHaveBeenCalledTimes(201);
    expect(queries(prisma).slice(1)).toEqual([
      expiredRecycleBinNotesQuery({ deletedBefore, limit: 200 }),
      expiredRecycleBinNotesQuery({
        deletedBefore,
        after: { at: full[199].cursorAt, id: 'n199' },
        limit: 200,
      }),
    ]);
  });

  it('swallows database failures so the next run retries', async () => {
    const { prisma, cleanup } = createHarness({});
    prisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));

    await expect(cleanup.sweep(now)).resolves.toBeUndefined();
    expect(purge).not.toHaveBeenCalled();
  });

  it('ships with the retention baseline migration for pre-existing deleted rows', () => {
    // 30 天保留期按 updatedAt 判龄：没有基线迁移的话，首次上线保留期时第一次扫描会追溯硬删
    // 用户几个月前（旧契约=永久可恢复）删的存量笔记。守住「清理任务与基线迁移一起出现」。
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
