import { jobMetrics } from '../metrics/job-metrics';
import { ChatBurnArchiveCleanupService } from './chat-burn-archive-cleanup.service';

describe('180-day burn archive cleanup', () => {
  const prisma: any = {
    $queryRaw: jest.fn(),
    chatBurnArchive: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
  };
  const media: any = {
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
  beforeEach(() => {
    jest.clearAllMocks();
    media.unreferencedArchiveMedia.mockImplementation(
      async (_tx, keys) => keys,
    );
    redis.tryAcquireLease.mockResolvedValue(undefined);
    prisma.$transaction = jest.fn(async (fn) => fn(prisma));
    prisma.chatBurnArchive.findMany.mockResolvedValue([
      { id: 'm1', conversationID: 'c1' },
    ]);
    prisma.chatBurnArchive.findUnique.mockResolvedValue({
      id: 'm1',
      type: 'image',
      retainUntil: new Date(0),
      content: { key: 'chat/u1/a.jpg' },
    });
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
    prisma.chatBurnArchive.findUnique.mockResolvedValue({
      id: 'm1',
      type: 'text',
      retainUntil: new Date(0),
      content: { key: 'chat/other/private.jpg' },
    });
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
  it('durably schedules attachment cleanup before erasing expired snapshots', async () => {
    await service.sweep();
    expect(media.queueDeletions).toHaveBeenCalledWith(
      prisma,
      ['chat/u1/a.jpg'],
      'm1',
    );
    expect(media.releaseNoteImportReferences).toHaveBeenCalledWith(
      prisma,
      ['m1'],
      [],
    );
    expect(prisma.chatBurnArchive.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
    expect(media.queueDeletions.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.chatBurnArchive.delete.mock.invocationCallOrder[0],
    );
  });
  it('rechecks expiry under lock and leaves a still-retained snapshot alone', async () => {
    prisma.chatBurnArchive.findUnique.mockResolvedValue({
      retainUntil: new Date(Date.now() + 86400_000),
    });
    await service.sweep();
    expect(prisma.chatBurnArchive.delete).not.toHaveBeenCalled();
    expect(media.queueDeletions).not.toHaveBeenCalled();
  });
  it('keeps the snapshot recoverable when durable media cleanup cannot be scheduled', async () => {
    media.queueDeletions.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(service.sweep()).rejects.toThrow('queue unavailable');
    expect(prisma.chatBurnArchive.delete).not.toHaveBeenCalled();
  });
});
