import { jobMetrics } from '../metrics/job-metrics';
import { ChatBurnArchiveCleanupService } from './chat-burn-archive-cleanup.service';

describe('180-day burn archive cleanup', () => {
  const prisma: any = {
    $queryRaw: jest.fn(),
    chatBurnArchive: {
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    e2eeArchive: { deleteMany: jest.fn() },
  };
  const media: any = {
    lockArchiveKeys: jest.fn(),
    queueDeletions: jest.fn(),
    unreferencedArchiveMedia: jest.fn(),
    releaseNoteImportReferences: jest.fn(),
    drainPendingDeletions: jest.fn(),
  };
  const redis: any = {
    tryAcquireLease: jest.fn(),
    renewLease: jest.fn(),
    releaseLease: jest.fn(),
  };
  const service = new ChatBurnArchiveCleanupService(prisma, media, redis);
  /** 到期扫描(事务外)之后,每个事务在会话行锁下按 id 重读这一批。 */
  const due = (rows: Array<{ id: string; conversationID: string }>) =>
    prisma.chatBurnArchive.findMany.mockImplementation(
      async (args: { where: { id?: { in: string[] } } }) =>
        args.where.id
          ? args.where.id.in.map((id: string) => archived(id))
          : rows,
    );
  const archived = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    type: 'image',
    retainUntil: new Date(0),
    content: { key: `chat/u1/${id}.jpg` },
    ...overrides,
  });
  /** 每个事务开头锁的是哪个会话。 */
  const lockedConversations = () =>
    prisma.$queryRaw.mock.calls.map((call: unknown[]) => call[1]);

  beforeEach(() => {
    jest.clearAllMocks();
    media.unreferencedArchiveMedia.mockImplementation(
      async (_tx, keys) => keys,
    );
    redis.tryAcquireLease.mockResolvedValue(undefined);
    prisma.$transaction = jest.fn(async (fn) => fn(prisma));
    due([{ id: 'm1', conversationID: 'c1' }]);
  });
  it('does not physically delete a key still referenced by a later archive or live message', async () => {
    media.unreferencedArchiveMedia.mockResolvedValue([]);
    await service.sweep();
    expect(media.queueDeletions).toHaveBeenCalledWith(prisma, [], 'm1');
    expect(prisma.chatBurnArchive.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
  });
  it('does not schedule hidden object keys in a non-media archive for deletion', async () => {
    prisma.chatBurnArchive.findMany.mockImplementation(async (args) =>
      args.where.id
        ? [archived('m1', { type: 'text', content: { key: 'chat/x/p.jpg' } })]
        : [{ id: 'm1', conversationID: 'c1' }],
    );
    await service.sweep();
    expect(media.queueDeletions).toHaveBeenCalledWith(prisma, [], 'm1');
    expect(media.releaseNoteImportReferences).toHaveBeenCalledWith(
      prisma,
      ['m1'],
      [],
    );
  });
  it('records a held-lease invocation as skipped rather than refreshing success', async () => {
    redis.tryAcquireLease.mockResolvedValue(null);
    const run = jest.spyOn(jobMetrics, 'recordRun');
    try {
      await service.sweep();
      expect(run).toHaveBeenCalledWith(
        'chat_burn_archive_cleanup',
        'skipped',
        expect.any(Number),
        undefined,
      );
      expect(prisma.chatBurnArchive.findMany).not.toHaveBeenCalled();
      expect(media.drainPendingDeletions).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
  it('durably schedules attachment cleanup before erasing expired snapshots and audit recovery', async () => {
    await service.sweep();
    expect(media.queueDeletions).toHaveBeenCalledWith(
      prisma,
      ['chat/u1/m1.jpg'],
      'm1',
    );
    expect(media.releaseNoteImportReferences).toHaveBeenCalledWith(
      prisma,
      ['m1'],
      [],
    );
    expect(prisma.e2eeArchive.deleteMany).toHaveBeenCalledWith({
      where: { messageID: 'm1', recovery: { purpose: 'AUDIT' } },
    });
    expect(prisma.chatBurnArchive.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
    expect(media.queueDeletions.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.chatBurnArchive.delete.mock.invocationCallOrder[0],
    );
  });
  it('rechecks expiry under lock and leaves a still-retained snapshot alone', async () => {
    prisma.chatBurnArchive.findMany.mockImplementation(async (args) =>
      args.where.id
        ? [archived('m1', { retainUntil: new Date(Date.now() + 86400_000) })]
        : [{ id: 'm1', conversationID: 'c1' }],
    );
    await service.sweep();
    expect(prisma.chatBurnArchive.delete).not.toHaveBeenCalled();
    expect(media.queueDeletions).not.toHaveBeenCalled();
  });
  it('keeps the snapshot recoverable when durable media cleanup cannot be scheduled', async () => {
    media.queueDeletions.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(service.sweep()).rejects.toThrow('queue unavailable');
    expect(prisma.chatBurnArchive.delete).not.toHaveBeenCalled();
  });

  // 原来每行一个事务、每行锁一次会话行:一轮 200 行就是 200 次 BEGIN/锁/COMMIT。
  // 同一会话的到期归档(同一批焚毁出来的,retainUntil 挨在一起)现在共用一个事务。
  it('cleans the due rows of one conversation in one transaction under one row lock', async () => {
    due([
      { id: 'a1', conversationID: 'c1' },
      { id: 'b1', conversationID: 'c2' },
      { id: 'a2', conversationID: 'c1' },
    ]);

    await service.sweep();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(lockedConversations()).toEqual(['c1', 'c2']);
    expect(prisma.chatBurnArchive.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
    });
    expect(
      prisma.chatBurnArchive.delete.mock.calls.map(
        ([args]: [{ where: { id: string } }]) => args.where.id,
      ),
    ).toEqual(['a1', 'a2', 'b1']);
    // 会话行锁在读归档、动附件之前。
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      media.lockArchiveKeys.mock.invocationCallOrder[0],
    );
  });

  // 会话行锁期间同会话的发消息要排队:一个事务里的行数有上限。
  it('caps how many rows one transaction holds the conversation lock for', async () => {
    due(
      Array.from({ length: 60 }, (_, i) => ({
        id: `m${i}`,
        conversationID: 'c1',
      })),
    );

    await service.sweep();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(lockedConversations()).toEqual(['c1', 'c1']);
    expect(prisma.chatBurnArchive.delete).toHaveBeenCalledTimes(60);
  });

  // 逐行处理时每行各自给附件 key 加 advisory 锁,一个事务里跨行的加锁顺序就乱了 ——
  // 和按「自有附件 key、再笔记导入 key,各自排序」加锁的焚毁清扫交叉就会死锁。
  // 先按统一顺序把整批的 key 一次锁齐(advisory 锁可重入,后面逐行再拿是空操作)。
  it('takes every media key lock of the batch up front before per-row work', async () => {
    due([
      { id: 'z', conversationID: 'c1' },
      { id: 'a', conversationID: 'c1' },
    ]);

    await service.sweep();

    expect(media.lockArchiveKeys).toHaveBeenCalledTimes(1);
    expect(media.lockArchiveKeys).toHaveBeenCalledWith(prisma, [
      'chat/u1/z.jpg',
      'chat/u1/a.jpg',
    ]);
    expect(media.lockArchiveKeys.mock.invocationCallOrder[0]).toBeLessThan(
      media.unreferencedArchiveMedia.mock.invocationCallOrder[0],
    );
  });
});
