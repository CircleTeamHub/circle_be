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
});
