import { readFileSync } from 'fs';
import { join } from 'path';
import { NoteRecycleBinCleanup } from './note-recycle-bin.cleanup';

describe('NoteRecycleBinCleanup', () => {
  function createHarness() {
    const prisma = {
      note: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const cleanup = new NoteRecycleBinCleanup(prisma as never);
    return { prisma, cleanup };
  }

  it('hard-deletes only recycle-bin (DELETED) notes past the 30-day retention', async () => {
    const { prisma, cleanup } = createHarness();
    prisma.note.deleteMany.mockResolvedValueOnce({ count: 2 });

    await cleanup.sweep(new Date('2026-08-16T04:00:00.000Z'));

    // 下架（UNLISTED）永不进 where —— 用户拍板：下架是长期仓库，只有回收站到期删。
    expect(prisma.note.deleteMany).toHaveBeenCalledWith({
      where: {
        status: 'DELETED',
        updatedAt: { lt: new Date('2026-07-17T04:00:00.000Z') },
      },
    });
  });

  it('swallows database failures so the daily cron can retry tomorrow', async () => {
    const { prisma, cleanup } = createHarness();
    prisma.note.deleteMany.mockRejectedValueOnce(new Error('db down'));

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
