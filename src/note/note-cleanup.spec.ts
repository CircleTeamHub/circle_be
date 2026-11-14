import { Prisma } from 'src/generated/prisma';
import { NoteCleanup } from './note-cleanup';
import {
  deletedNotesQuery,
  expiredUnlistedNotesQuery,
  type NoteCleanupRow,
} from './note-cleanup.query';
import { purgeDeletedNote } from './note-purge';
import { NOTE_UNLISTED_RETENTION_MS } from './note.service';

jest.mock('./note-purge', () => ({ purgeDeletedNote: jest.fn() }));

/**
 * 候选查询的口径（只取 DELETED / 下架满 60 天、键集不重不漏、走部分索引）在真库
 * test/postgres/note-cleanup.pg-spec.ts 里跑；这里守任务的编排：先让到期的下架笔记
 * 走删除，再把所有已删除的物理删掉，单行失败跳过、整轮失败吞掉等下一轮。
 */
describe('NoteCleanup', () => {
  const purge = jest.mocked(purgeDeletedNote);
  const now = new Date('2026-11-13T12:00:00.000Z');
  const unlistedBefore = new Date('2026-09-14T12:00:00.000Z');

  const row = (
    id: string,
    at = '2026-01-01T00:00:00.000Z',
  ): NoteCleanupRow => ({
    id,
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

  it('uses an absolute 60 × 24h window', () => {
    expect(NOTE_UNLISTED_RETENTION_MS).toBe(60 * 24 * 60 * 60 * 1000);
    expect(now.getTime() - unlistedBefore.getTime()).toBe(
      NOTE_UNLISTED_RETENTION_MS,
    );
  });

  it('expires 下架 notes past 60 days first, then purges every deleted note', async () => {
    const { prisma, notes, cleanup } = createHarness({
      expired: [[row('old-unlisted')]],
      deleted: [[row('old-unlisted'), row('just-deleted')]],
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

    expect(queries(prisma)).toEqual([
      expiredUnlistedNotesQuery({ unlistedBefore, limit: 200 }),
      deletedNotesQuery({ limit: 200 }),
    ]);
    // 到期判定在写入时按同一截止时间复核（被重新上架的不动）。
    expect(notes.expireUnlistedNote).toHaveBeenCalledWith(
      row('old-unlisted'),
      unlistedBefore,
    );
    expect(order).toEqual([
      'expire:old-unlisted',
      'purge:old-unlisted',
      'purge:just-deleted',
    ]);
    expect(purge).toHaveBeenCalledWith(prisma, 'old-unlisted');
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
      deletedNotesQuery({ limit: 200 }),
      deletedNotesQuery({
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
});
