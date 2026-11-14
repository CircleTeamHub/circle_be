import { Logger } from '@nestjs/common';
import { ChatMediaRetentionService } from './chat-media-retention.service';

type SqlArg = { sql?: string; values?: unknown[] } | TemplateStringsArray;
const sqlText = (arg: SqlArg): string =>
  Array.isArray(arg)
    ? (arg as TemplateStringsArray).join('?')
    : ((arg as { sql: string }).sql ?? '');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-10T05:00:00.000Z');

describe('ChatMediaRetentionService', () => {
  const prisma = { $transaction: jest.fn(), $queryRaw: jest.fn() };
  const media = {
    queueDeletions: jest.fn(),
    releaseNoteImportReferences: jest.fn(),
    drainPendingDeletions: jest.fn(),
  };
  const redis = {
    tryAcquireLease: jest.fn(),
    renewLease: jest.fn(),
    releaseLease: jest.fn(),
  };
  const lease = { isCurrent: jest.fn(() => true) };
  const service = new ChatMediaRetentionService(
    prisma as never,
    media as never,
    redis as never,
  );

  /** 每类媒体返回的候选;没列出的类型返回空。 */
  let candidates: Record<string, Array<Record<string, unknown>>>;
  /** 清理语句按 id 带回的旧 key。 */
  let purgedContent: Record<string, Record<string, string>>;
  const calls: string[] = [];

  beforeEach(() => {
    jest.resetAllMocks();
    calls.length = 0;
    lease.isCurrent.mockReturnValue(true);
    candidates = {};
    purgedContent = {};
    media.queueDeletions.mockResolvedValue(undefined);
    media.releaseNoteImportReferences.mockResolvedValue(undefined);
    media.drainPendingDeletions.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    prisma.$queryRaw.mockImplementation(async (arg: SqlArg, ...rest) => {
      const text = sqlText(arg);
      if (text.includes('FOR UPDATE') && text.includes('"ChatConversation"')) {
        calls.push(`lock:${rest[0]}`);
        return [{ id: rest[0] }];
      }
      if (text.includes('UPDATE "ChatMessage"')) {
        const ids = (arg as { values: unknown[] }).values[0] as string[];
        calls.push(`purge:${ids.join(',')}`);
        return ids
          .filter((id) => purgedContent[id])
          .map((id) => ({ id, ...purgedContent[id] }));
      }
      const type = /"type" = '([a-z-]+)'/.exec(text)?.[1] ?? '';
      calls.push(`scan:${type}`);
      return candidates[type]?.splice(0) ?? [];
    });
  });

  const row = (id: string, conversationID: string, ageDays: number) => ({
    id,
    conversationID,
    createdAt: new Date(now - ageDays * DAY),
  });

  it('scans each media type against its own cutoff with the type as a SQL literal', async () => {
    await service.purgeOnce(lease, now);

    const scans = prisma.$queryRaw.mock.calls.map(
      ([arg]) => arg as { sql: string; values: unknown[] },
    );
    expect(
      scans.map((scan) => /"type" = '([a-z-]+)'/.exec(scan.sql)?.[1]),
    ).toEqual(['video', 'image', 'voice', 'file']);
    expect(scans[0].values).toContainEqual(new Date(now - 30 * DAY));
    expect(scans[1].values).toContainEqual(new Date(now - 365 * DAY));
    // 没有到期媒体就不去碰删除队列。
    expect(media.drainPendingDeletions).not.toHaveBeenCalled();
  });

  it('locks the conversation before rewriting its messages and queues the old objects', async () => {
    candidates.video = [row('v1', 'c1', 31), row('v2', 'c1', 40)];
    purgedContent = {
      v1: { key: 'chat/u1/a.mp4', thumbKey: 'chat/u1/a.jpg' },
      v2: { key: 'chat/u1/note-import/abc', thumbKey: null as never },
    };

    await expect(service.purgeOnce(lease, now)).resolves.toBe(2);

    expect(calls.slice(0, 3)).toEqual(['scan:video', 'lock:c1', 'purge:v1,v2']);
    expect(media.queueDeletions).toHaveBeenCalledWith(prisma, [
      'chat/u1/a.mp4',
      'chat/u1/a.jpg',
    ]);
    expect(media.releaseNoteImportReferences).toHaveBeenCalledWith(
      prisma,
      ['v1', 'v2'],
      ['chat/u1/note-import/abc'],
    );
    expect(media.drainPendingDeletions).toHaveBeenCalledTimes(1);
  });

  it('skips collected messages inside the purge statement', async () => {
    candidates.image = [row('i1', 'c1', 400)];
    // 清理语句里 NOT EXISTS UserCollection 把它排除:没有带回任何行。
    await expect(service.purgeOnce(lease, now)).resolves.toBe(0);

    const purge = prisma.$queryRaw.mock.calls
      .map(([arg]) => sqlText(arg as SqlArg))
      .find((text) => text.includes('UPDATE "ChatMessage"'));
    expect(purge).toContain('"UserCollection"');
    expect(purge).toContain('"burnDurationSec" IS NULL');
    expect(media.queueDeletions).not.toHaveBeenCalled();
  });

  it('does not let an unrelated note collection pin chat media forever', async () => {
    candidates.video = [row('v1', 'c1', 31)];

    await service.purgeOnce(lease, now);

    const purge = prisma.$queryRaw.mock.calls
      .map(([arg]) => sqlText(arg as SqlArg))
      .find((text) => text.includes('UPDATE "ChatMessage"'));
    expect(purge).toContain(`c."type" <> 'NOTE'`);
    expect(purge).toContain(`c."payload" ->> 'kind' = 'openim-message'`);
  });

  it('pages past a full batch with the (createdAt, id) keyset', async () => {
    const full = Array.from({ length: 500 }, (_, index) =>
      row(`v${index}`, 'c1', 31),
    );
    const last = full[full.length - 1];
    candidates.video = full;

    await service.purgeOnce(lease, now);

    const videoScans = prisma.$queryRaw.mock.calls
      .map(([arg]) => arg as { sql: string; values: unknown[] })
      .filter((arg) => arg.sql?.includes(`"type" = 'video'`));
    expect(videoScans).toHaveLength(2);
    expect(videoScans[1].sql).toContain('("createdAt", "id") >');
    expect(videoScans[1].values).toEqual(
      expect.arrayContaining([last.createdAt, last.id]),
    );
  });

  // 首次上线或停摆后的积压:同一会话一批可能有几百条。整批放进一个事务会超出
  // 交互事务的时限、整批回滚,而游标已经越过它们,这个会话就天天失败。
  it('splits a large conversation into small transactions', async () => {
    candidates.video = Array.from({ length: 120 }, (_, index) =>
      row(`v${index}`, 'busy', 31),
    );
    purgedContent = Object.fromEntries(
      candidates.video.map((item) => [
        item.id,
        { key: `chat/u1/${item.id}.mp4` },
      ]),
    );

    await expect(service.purgeOnce(lease, now)).resolves.toBe(120);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(calls.filter((call) => call === 'lock:busy')).toHaveLength(3);
  });

  it('keeps going after one conversation fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    candidates.video = [row('v1', 'broken', 31), row('v2', 'c2', 31)];
    purgedContent = { v2: { key: 'chat/u2/b.mp4' } };
    prisma.$transaction
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
      );

    await expect(service.purgeOnce(lease, now)).resolves.toBe(1);
    expect(media.queueDeletions).toHaveBeenCalledWith(prisma, [
      'chat/u2/b.mp4',
    ]);
  });

  it('stops rewriting once the lease is lost', async () => {
    candidates.video = [row('v1', 'c1', 31)];
    lease.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);

    await expect(service.purgeOnce(lease, now)).resolves.toBe(0);
    expect(calls.some((call) => call.startsWith('purge:'))).toBe(false);
  });
});
