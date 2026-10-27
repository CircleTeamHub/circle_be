import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expiredRecycleBinNotesQuery } from 'src/note/note-recycle-bin.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * Note 上两条部分索引（迁移 20261026000500）在真 PostgreSQL 上的口径与成本：
 * - 回收站到期清理按 (updatedAt, id) 键集翻页：只取到期的 DELETED 行、不重不漏、
 *   不反复取到同一行，并且落在 Note_recycle_bin_updatedAt_id_idx 上；
 * - 收录链下游（永久删除改指向、来源状态广播）按 collectedFromNoteID 等值 / IN
 *   查找，落在 Note_collectedFromNoteID_present_idx 上，而不是以 ownerID 打头的
 *   活跃副本唯一索引或整表扫描。
 */
describePostgres(
  'note collect-chain and recycle-bin indexes (PostgreSQL)',
  () => {
    let s: IsolatedSchema;
    const capture = capturePrisma();

    const MIGRATION =
      'prisma/migrations/20261026000500_note_collect_chain_and_recycle_bin_indexes/migration.sql';

    const insertNote = async (
      id: string,
      note: {
        ownerID?: string;
        status?: 'ACTIVE' | 'UNLISTED' | 'DELETED';
        updatedAt: string;
        collectedFromNoteID?: string | null;
      },
    ) => {
      await s.db.query(
        `INSERT INTO "Note" (id, "ownerID", status, "updatedAt", "collectedFromNoteID")
       VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          note.ownerID ?? 'owner',
          note.status ?? 'DELETED',
          note.updatedAt,
          note.collectedFromNoteID ?? null,
        ],
      );
    };

    /** 照清理任务的写法逐批翻页，返回每批的 id。 */
    const pageAll = async (cutoff: Date, limit: number) => {
      const pages: string[][] = [];
      let after: { updatedAt: Date; id: string } | undefined;
      for (;;) {
        const q = expiredRecycleBinNotesQuery({ cutoff, after, limit });
        const { rows } = await s.db.query<{ id: string; updatedAt: Date }>(
          q.text,
          q.values,
        );
        pages.push(rows.map((row) => row.id));
        if (rows.length < limit) break;
        const last = rows[rows.length - 1];
        after = { updatedAt: last.updatedAt, id: last.id };
      }
      return pages;
    };

    beforeAll(async () => {
      s = await openIsolatedSchema('note_collect_chain');
      await s.db.query(`
      CREATE TYPE "NoteStatus" AS ENUM ('ACTIVE', 'UNLISTED', 'DELETED');
      CREATE TABLE "Note" (
        id text PRIMARY KEY,
        "ownerID" text NOT NULL,
        status "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
        pinned boolean NOT NULL DEFAULT false,
        "collectedFromNoteID" text,
        "updatedAt" timestamp(3) NOT NULL
      );
      -- 线上已有、会和新索引竞争的两条：以 ownerID 打头的普通索引与活跃副本唯一索引。
      CREATE INDEX "Note_ownerID_status_updatedAt_idx"
        ON "Note" ("ownerID", status, "updatedAt");
      CREATE UNIQUE INDEX "Note_ownerID_collectedFromNoteID_active_key"
        ON "Note" ("ownerID", "collectedFromNoteID")
        WHERE "collectedFromNoteID" IS NOT NULL AND status <> 'DELETED';
    `);
      // CREATE INDEX CONCURRENTLY 不能放进多语句的隐式事务，和 Prisma 一样逐条执行。
      const statements = readFileSync(join(process.cwd(), MIGRATION), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      expect(statements).toHaveLength(2);
      for (const statement of statements) {
        await s.db.query(statement);
      }
    });

    afterAll(async () => {
      await s?.close();
    });

    beforeEach(async () => {
      await s.db.query('TRUNCATE "Note"');
    });

    it('pages expired recycle-bin notes by (updatedAt, id) without gaps or repeats', async () => {
      // 同一时刻删的一批（updatedAt 相同），id 决出先后。
      for (const id of ['b', 'a', 'd', 'c']) {
        await insertNote(id, { updatedAt: '2026-06-01 00:00:00' });
      }
      await insertNote('e', { updatedAt: '2026-06-02 00:00:00' });
      await insertNote('f', { updatedAt: '2026-06-30 23:59:59.999' });
      // 不在口径内：刚删的（还没到 30 天）、下架的、正常的。
      await insertNote('recent', { updatedAt: '2026-07-01 00:00:00' });
      await insertNote('unlisted', {
        status: 'UNLISTED',
        updatedAt: '2026-01-01 00:00:00',
      });
      await insertNote('active', {
        status: 'ACTIVE',
        updatedAt: '2026-01-01 00:00:00',
      });

      const cutoff = new Date('2026-07-01T00:00:00.000Z');
      const pages = await pageAll(cutoff, 2);

      expect(pages).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], []]);
    });

    it('moves past rows the sweep failed to delete instead of fetching them again', async () => {
      for (let index = 0; index < 5; index += 1) {
        await insertNote(`n${index}`, { updatedAt: '2026-06-01 00:00:00' });
      }

      // 什么都没删（相当于整批都删失败）：每行仍然只出现一次，翻页照样走到底。
      const pages = await pageAll(new Date('2026-07-01T00:00:00.000Z'), 2);

      expect(pages.flat()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    });

    it('reads a recycle-bin batch through the partial (updatedAt, id) index', async () => {
      // 大量正常笔记 + 尚未到期的回收站笔记，到期的只有几条。
      await s.db.query(`
      INSERT INTO "Note" (id, "ownerID", status, "updatedAt")
      SELECT 'filler-' || g, 'owner-' || (g % 200),
             CASE WHEN g % 10 = 0 THEN 'DELETED'::"NoteStatus" ELSE 'ACTIVE'::"NoteStatus" END,
             TIMESTAMP '2026-07-10 00:00:00' + (g || ' seconds')::interval
      FROM generate_series(1, 5000) g
    `);
      await insertNote('expired', { updatedAt: '2026-06-01 00:00:00' });
      await s.db.query('ANALYZE "Note"');

      const cutoff = new Date('2026-07-01T00:00:00.000Z');
      await s.db.query('SET enable_seqscan = off');
      try {
        const first = expiredRecycleBinNotesQuery({ cutoff, limit: 200 });
        expect(await explainPlan(s.db, first.text, first.values)).toContain(
          'Note_recycle_bin_updatedAt_id_idx',
        );
        const next = expiredRecycleBinNotesQuery({
          cutoff,
          after: { updatedAt: new Date('2026-05-01T00:00:00.000Z'), id: 'x' },
          limit: 200,
        });
        expect(await explainPlan(s.db, next.text, next.values)).toContain(
          'Note_recycle_bin_updatedAt_id_idx',
        );
      } finally {
        await s.db.query('RESET enable_seqscan');
      }
      expect((await pageAll(cutoff, 200)).flat()).toEqual(['expired']);
    });

    it('could not use the recycle-bin index through Prisma\u2019s parameterized enum filter', async () => {
      await s.db.query(`
      INSERT INTO "Note" (id, "ownerID", status, "updatedAt")
      SELECT 'filler-' || g, 'owner-' || (g % 200), 'ACTIVE', TIMESTAMP '2026-07-10 00:00:00'
      FROM generate_series(1, 2000) g
    `);
      await s.db.query('ANALYZE "Note"');
      // 对照：改造前清理任务的 note.findMany，现场编译出 Prisma 的真实 SQL。status 是
      // CAST($n::text AS "NoteStatus")，规划期折不成常量，部分索引用不上 —— 所以批次
      // 查询改成了原生 SQL（expiredRecycleBinNotesQuery），别再「简化」回 findMany。
      const [prismaShape] = await captureQueries(capture.queries, () =>
        capture.prisma.note.findMany({
          where: {
            status: 'DELETED',
            updatedAt: { lt: new Date('2026-07-01T00:00:00.000Z') },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 200,
        }),
      );
      expect(prismaShape.sql).toContain('CAST(');

      await s.db.query('SET enable_seqscan = off');
      try {
        expect(
          await explainPlan(s.db, prismaShape.sql, prismaShape.args),
        ).not.toContain('Note_recycle_bin_updatedAt_id_idx');
      } finally {
        await s.db.query('RESET enable_seqscan');
      }
    });

    it('finds collect-chain children through the collectedFromNoteID partial index', async () => {
      await s.db.query(`
      INSERT INTO "Note" (id, "ownerID", status, "updatedAt", "collectedFromNoteID")
      SELECT 'filler-' || g, 'owner-' || (g % 300), 'ACTIVE', TIMESTAMP '2026-07-10 00:00:00',
             CASE WHEN g % 20 = 0 THEN 'source-' || g END
      FROM generate_series(1, 5000) g
    `);
      await insertNote('child-1', {
        ownerID: 'agent-1',
        status: 'ACTIVE',
        updatedAt: '2026-07-10 00:00:00',
        collectedFromNoteID: 'source-note',
      });
      await insertNote('child-2', {
        ownerID: 'agent-2',
        updatedAt: '2026-07-10 00:00:00',
        collectedFromNoteID: 'source-note',
      });
      await s.db.query('ANALYZE "Note"');

      // 来源状态广播的下游遍历（note.service.ts broadcastSourceStatusChanged）：同一个
      // Prisma 调用现场编译成 SQL（WHERE "collectedFromNoteID" IN ($1,$2)），不手抄。
      const [descendants] = await captureQueries(capture.queries, () =>
        capture.prisma.note.findMany({
          where: { collectedFromNoteID: { in: ['source-note', 'missing'] } },
          select: { id: true, ownerID: true },
        }),
      );
      expect(descendants.sql).toContain('"collectedFromNoteID" IN (');
      // purgeDeletedNote 改指向的原生 UPDATE（note-purge.ts，未抽成构造器，照抄谓词）。
      const relink = `UPDATE "Note" AS child SET "collectedFromNoteID" = $2
      WHERE child."collectedFromNoteID" = $1
        AND (child.status = 'DELETED' OR NOT EXISTS (
          SELECT 1 FROM "Note" AS dup
          WHERE dup."ownerID" = child."ownerID" AND dup."collectedFromNoteID" = $2
            AND dup.status <> 'DELETED' AND dup.id <> child.id))`;

      await s.db.query('SET enable_seqscan = off');
      try {
        expect(
          await explainPlan(s.db, descendants.sql, descendants.args),
        ).toContain('Note_collectedFromNoteID_present_idx');
        expect(
          await explainPlan(s.db, relink, ['source-note', 'grand-source']),
        ).toContain('Note_collectedFromNoteID_present_idx');
      } finally {
        await s.db.query('RESET enable_seqscan');
      }

      const { rows } = await s.db.query<{ id: string }>(
        descendants.sql,
        descendants.args,
      );
      expect(
        rows.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
      ).toEqual(['child-1', 'child-2']);
    });
  },
);
