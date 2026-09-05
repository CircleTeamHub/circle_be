import * as trackedCron from 'src/metrics/tracked-cron.decorator';
import { ChatDirectAutoReplyProcessor } from './chat-direct-auto-reply.processor';

describe('ChatDirectAutoReplyProcessor', () => {
  const createdAt = new Date('2026-09-04T05:00:00.000Z');
  const source = (id = 'source-1') => ({
    id,
    conversationID: 'conv-1',
    height: 4,
    senderID: 'u1',
    type: 'text',
    content: { text: 'hello' },
    clientMessageId: `client-${id}`,
    replyToID: null,
    deleted: false,
    revokedAt: null,
    createdAt,
    conversation: { id: 'conv-1', type: 'DIRECT' },
  });
  const reply = {
    id: 'reply-1',
    conversationID: 'conv-1',
    height: 5,
    senderID: 'u2',
    type: 'text',
    content: { text: '稍后回复', autoReply: true },
    clientMessageId: 'dm-auto:source-1:u2',
    replyToID: null,
    deleted: false,
    revokedAt: null,
    createdAt,
  };

  const prisma = {
    chatDirectAutoReplyJob: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    chatMessage: { findUnique: jest.fn(), create: jest.fn() },
    chatConversation: { update: jest.fn() },
    chatMember: { findMany: jest.fn(), updateMany: jest.fn() },
    block: { findFirst: jest.fn() },
    chatDirectAutoReplyState: {
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    userPrivacySetting: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const broadcast = { emitMessage: jest.fn() };
  const push = { onMessageBroadcast: jest.fn() };
  const sensitiveWords = { check: jest.fn() };
  let processor: ChatDirectAutoReplyProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    prisma.chatDirectAutoReplyJob.findUnique.mockResolvedValue({ id: 'job-1' });
    prisma.chatDirectAutoReplyJob.findUniqueOrThrow.mockResolvedValue({
      sourceMessageID: 'source-1',
      attempts: 1,
    });
    prisma.chatDirectAutoReplyJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatDirectAutoReplyJob.update.mockResolvedValue({});
    prisma.chatMessage.findUnique.mockImplementation(async (args: any) =>
      args.where.id ? source(args.where.id) : null,
    );
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
      const sql = query.join(' ');
      if (sql.includes('FROM "ChatConversation"')) {
        return [{ nextHeight: 4 }];
      }
      if (sql.includes('FROM "User"')) {
        return [
          {
            id: 'u2',
            nickname: 'Responder',
            avatarUrl: null,
            status: 'ACTIVE',
          },
        ];
      }
      return [{ now: createdAt }];
    });
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u1' },
      { userID: 'u2' },
    ]);
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: '  稍后回复  ',
    });
    prisma.chatDirectAutoReplyState.findUnique.mockResolvedValue(null);
    prisma.chatMessage.create.mockResolvedValue(reply);
    prisma.chatConversation.update.mockResolvedValue({});
    prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
    prisma.chatDirectAutoReplyState.upsert.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({
      id: 'u2',
      nickname: 'Responder',
      avatarUrl: null,
      status: 'ACTIVE',
    });
    broadcast.emitMessage.mockResolvedValue(undefined);
    push.onMessageBroadcast.mockResolvedValue(undefined);
    sensitiveWords.check.mockReturnValue({ blocked: false });
    processor = new ChatDirectAutoReplyProcessor(
      prisma as never,
      broadcast as never,
      push as never,
      sensitiveWords as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [false, '稍后回复'],
    [true, '   '],
  ])(
    'completes without replying when enabled=%s and text=%p',
    async (enabled, text) => {
      prisma.userPrivacySetting.findUnique.mockResolvedValue({
        directMessageAutoReplyEnabled: enabled,
        directMessageAutoReplyText: text,
      });

      await processor.processMessage('source-1');

      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
      expect(prisma.chatDirectAutoReplyJob.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'COMPLETED', lockedAt: null }),
      });
      expect(broadcast.emitMessage).not.toHaveBeenCalled();
    },
  );

  it('does not send a stored auto reply that matches the current sensitive-word list', async () => {
    sensitiveWords.check.mockReturnValue({ blocked: true, word: 'blocked' });

    await processor.processMessage('source-1');

    expect(sensitiveWords.check).toHaveBeenCalledWith('稍后回复');
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(prisma.chatDirectAutoReplyJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'COMPLETED', lockedAt: null }),
    });
  });

  it('uses current active members to send a trimmed deterministic reply as the peer', async () => {
    await processor.processMessage('source-1');

    expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      select: { userID: true },
    });
    expect(prisma.chatMessage.create).toHaveBeenCalledWith({
      data: {
        conversationID: 'conv-1',
        height: 5,
        senderID: 'u2',
        type: 'text',
        content: { text: '稍后回复', autoReply: true },
        clientMessageId: 'dm-auto:source-1:u2',
        replyToID: null,
        createdAt,
      },
    });
    expect(prisma.chatConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { nextHeight: 5, lastMessageAt: createdAt },
    });
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    expect(prisma.chatDirectAutoReplyState.upsert).toHaveBeenCalledWith({
      where: {
        conversationID_responderID: {
          conversationID: 'conv-1',
          responderID: 'u2',
        },
      },
      create: {
        conversationID: 'conv-1',
        responderID: 'u2',
        lastRepliedAt: createdAt,
      },
      update: { lastRepliedAt: createdAt },
    });
  });

  it('serializes with relationship changes and skips a reply after either user blocks', async () => {
    prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });

    await processor.processMessage('source-1');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.block.findFirst.mock.invocationCallOrder[0],
    );
    expect(prisma.block.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerID: 'u1', blockedID: 'u2' },
          { blockerID: 'u2', blockedID: 'u1' },
        ],
      },
      select: { id: true },
    });
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(broadcast.emitMessage).not.toHaveBeenCalled();
    expect(push.onMessageBroadcast).not.toHaveBeenCalled();
  });

  it('skips a reply when the responder account is no longer active', async () => {
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
      const sql = query.join(' ');
      if (sql.includes('FROM "ChatConversation"')) {
        return [{ nextHeight: 4 }];
      }
      if (sql.includes('FROM "User"')) {
        return [
          {
            id: 'u2',
            nickname: 'Responder',
            avatarUrl: null,
            status: 'BANNED',
          },
        ];
      }
      return [{ now: createdAt }];
    });

    await processor.processMessage('source-1');

    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(broadcast.emitMessage).not.toHaveBeenCalled();
    expect(push.onMessageBroadcast).not.toHaveBeenCalled();
  });

  it('locks the responder user row so a concurrent ban is serialized', async () => {
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
      const sql = query.join(' ');
      if (sql.includes('FROM "ChatConversation"')) {
        return [{ nextHeight: 4 }];
      }
      if (sql.includes('FROM "User"')) {
        return [
          {
            id: 'u2',
            nickname: 'Responder',
            avatarUrl: null,
            status: 'BANNED',
          },
        ];
      }
      return [{ now: createdAt }];
    });

    await processor.processMessage('source-1');

    expect(
      prisma.$queryRaw.mock.calls.some(([query]) => {
        const sql = (query as TemplateStringsArray).join(' ');
        return sql.includes('FROM "User"') && sql.includes('FOR UPDATE');
      }),
    ).toBe(true);
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('does not duplicate a reply when its deterministic message already exists', async () => {
    prisma.chatMessage.findUnique.mockImplementation(async (args: any) =>
      args.where.id ? source(args.where.id) : reply,
    );

    await processor.processMessage('source-1');

    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(prisma.chatDirectAutoReplyState.upsert).not.toHaveBeenCalled();
    expect(broadcast.emitMessage).not.toHaveBeenCalled();
    expect(push.onMessageBroadcast).not.toHaveBeenCalled();
  });

  it('completes an accidentally queued server auto reply without creating a loop', async () => {
    prisma.chatMessage.findUnique.mockImplementation(async (args: any) =>
      args.where.id
        ? {
            ...source(args.where.id),
            content: { text: '稍后回复', autoReply: true },
          }
        : null,
    );

    await processor.processMessage('source-1');

    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(prisma.chatDirectAutoReplyJob.create).not.toHaveBeenCalled();
    expect(prisma.chatDirectAutoReplyJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
  });

  it('suppresses a second reply inside the per-responder conversation cooldown', async () => {
    prisma.chatDirectAutoReplyState.findUnique.mockResolvedValue({
      lastRepliedAt: new Date(createdAt.getTime() - 29_000),
    });

    await processor.processMessage('source-1');

    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(prisma.chatDirectAutoReplyState.upsert).not.toHaveBeenCalled();
  });

  it('uses the database clock for cooldown decisions across app instances', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(createdAt.getTime() + 24 * 60 * 60_000);
    prisma.chatDirectAutoReplyState.findUnique.mockResolvedValue({
      lastRepliedAt: new Date(createdAt.getTime() - 29_000),
    });

    await processor.processMessage('source-1');

    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('records reply and cooldown timestamps from a post-lock database clock', async () => {
    const transactionStartedAt = new Date('2026-09-04T05:00:00.000Z');
    const lockAcquiredAt = new Date('2026-09-04T05:01:00.000Z');
    prisma.$queryRaw
      .mockResolvedValueOnce([{ nextHeight: 4, now: transactionStartedAt }])
      .mockResolvedValueOnce([
        {
          id: 'u2',
          nickname: 'Responder',
          avatarUrl: null,
          status: 'ACTIVE',
        },
      ])
      .mockResolvedValueOnce([{ now: lockAcquiredAt }]);
    prisma.chatMessage.create.mockImplementation(async ({ data }: any) => ({
      ...reply,
      ...data,
    }));

    await processor.processMessage('source-1');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.chatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdAt: lockAcquiredAt }),
    });
    expect(prisma.chatDirectAutoReplyState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ lastRepliedAt: lockAcquiredAt }),
        update: { lastRepliedAt: lockAcquiredAt },
      }),
    );
  });

  it('broadcasts and pushes only after the reply transaction commits', async () => {
    const events: string[] = [];
    prisma.$transaction.mockImplementation(async (callback: any) => {
      const result = await callback(prisma);
      events.push('commit');
      return result;
    });
    broadcast.emitMessage.mockImplementation(async () => {
      events.push('broadcast');
    });
    push.onMessageBroadcast.mockImplementation(async () => {
      events.push('push');
    });

    await processor.processMessage('source-1');

    expect(events).toEqual(['commit', 'broadcast', 'push']);
    expect(broadcast.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reply-1',
        conversationId: 'conv-1',
        sender: { id: 'u2', nickname: 'Responder', avatarUrl: null },
        content: { text: '稍后回复', autoReply: true },
      }),
    );
  });

  it('does not retry a committed reply when realtime delivery fails closed', async () => {
    broadcast.emitMessage.mockRejectedValue(new Error('adapter offline'));

    await expect(processor.processMessage('source-1')).resolves.toBeUndefined();

    expect(prisma.chatDirectAutoReplyJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'COMPLETED' }),
    });
    expect(prisma.chatDirectAutoReplyJob.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(push.onMessageBroadcast).toHaveBeenCalled();
  });

  it('backs off failed work with a fixed redacted error category', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const warn = jest
      .spyOn((processor as any).logger, 'warn')
      .mockImplementation(() => undefined);
    prisma.$transaction.mockRejectedValue(
      new Error('private body from user u1 with secret-token'),
    );

    await processor.processMessage('source-1');

    expect(prisma.chatDirectAutoReplyJob.update).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'PENDING',
        lockedAt: null,
        nextAttemptAt: new Date(now + 2_000),
        lastError: 'PROCESSING_FAILED',
      },
    });
    expect(
      JSON.stringify(prisma.chatDirectAutoReplyJob.update.mock.calls),
    ).not.toContain('secret-token');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /private body|user u1|secret-token/,
    );
  });

  it('dead-letters the fifth failed attempt instead of retrying forever', async () => {
    prisma.chatDirectAutoReplyJob.findUniqueOrThrow.mockResolvedValue({
      sourceMessageID: 'source-1',
      attempts: 5,
    });
    prisma.$transaction.mockRejectedValue(new Error('database unavailable'));

    await processor.processMessage('source-1');

    expect(prisma.chatDirectAutoReplyJob.update).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        lockedAt: null,
        lastError: 'PROCESSING_FAILED',
      }),
    });
  });

  it('recovers stale processing jobs during the cron sweep', async () => {
    prisma.chatDirectAutoReplyJob.findMany.mockResolvedValue([]);

    await processor.sweep();

    expect(prisma.chatDirectAutoReplyJob.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'PROCESSING',
        attempts: { lt: 5 },
        lockedAt: { lt: expect.any(Date) },
      },
      data: {
        status: 'PENDING',
        lockedAt: null,
        nextAttemptAt: expect.any(Date),
      },
    });
  });

  it('cleans up expired terminal jobs and stale cooldown state', async () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    prisma.chatDirectAutoReplyJob.findMany.mockResolvedValue([{ id: 'job-1' }]);
    prisma.chatDirectAutoReplyState.findMany.mockResolvedValue([
      { id: 'state-1' },
    ]);
    prisma.chatDirectAutoReplyJob.deleteMany.mockResolvedValue({ count: 4 });
    prisma.chatDirectAutoReplyState.deleteMany.mockResolvedValue({ count: 2 });

    await processor.cleanupExpired(now);

    expect(prisma.chatDirectAutoReplyJob.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['COMPLETED', 'FAILED'] },
        updatedAt: { lt: new Date('2026-09-13T00:00:00.000Z') },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: { id: true },
    });
    expect(prisma.chatDirectAutoReplyJob.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['job-1'] },
        status: { in: ['COMPLETED', 'FAILED'] },
        updatedAt: { lt: new Date('2026-09-13T00:00:00.000Z') },
      },
    });
    expect(prisma.chatDirectAutoReplyState.findMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: new Date('2026-09-19T00:00:00.000Z') } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: { id: true },
    });
    expect(prisma.chatDirectAutoReplyState.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['state-1'] },
        updatedAt: { lt: new Date('2026-09-19T00:00:00.000Z') },
      },
    });
  });

  it('splits retention cleanup into bounded delete batches', async () => {
    const fullBatch = Array.from({ length: 1000 }, (_, index) => ({
      id: `job-${index}`,
    }));
    prisma.chatDirectAutoReplyJob.findMany
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([{ id: 'job-final' }]);
    prisma.chatDirectAutoReplyState.findMany.mockResolvedValue([]);
    prisma.chatDirectAutoReplyJob.deleteMany.mockResolvedValue({ count: 1000 });

    await processor.cleanupExpired(new Date('2026-09-20T00:00:00.000Z'));

    expect(prisma.chatDirectAutoReplyJob.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.chatDirectAutoReplyJob.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.chatDirectAutoReplyJob.deleteMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ['job-final'] },
        status: { in: ['COMPLETED', 'FAILED'] },
        updatedAt: { lt: new Date('2026-09-13T00:00:00.000Z') },
      },
    });
  });

  it('reports an overlapping cleanup as skipped without refreshing its heartbeat', async () => {
    const skipped = jest.spyOn(trackedCron, 'reportJobSkipped');
    let releaseFirst!: () => void;
    prisma.chatDirectAutoReplyJob.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([]);
        }),
    );

    const first = processor.cleanupExpired(
      new Date('2026-09-20T00:00:00.000Z'),
    );
    await Promise.resolve();
    await processor.cleanupExpired(new Date('2026-09-20T00:00:01.000Z'));

    expect(skipped).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    skipped.mockRestore();
  });

  it('reports an overlapping job sweep as skipped without refreshing its heartbeat', async () => {
    const skipped = jest.spyOn(trackedCron, 'reportJobSkipped');
    let releaseFirst!: () => void;
    prisma.chatDirectAutoReplyJob.updateMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ count: 0 });
        }),
    );

    const first = processor.sweep();
    await Promise.resolve();
    await processor.sweep();

    expect(skipped).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    skipped.mockRestore();
  });

  it('serializes concurrent jobs so only one reply wins the cooldown', async () => {
    let transactionTail = Promise.resolve();
    let lastRepliedAt: Date | null = null;
    let replies = 0;
    prisma.chatDirectAutoReplyJob.findUnique.mockImplementation(
      async ({ where }: any) => ({ id: `job-${where.sourceMessageID}` }),
    );
    prisma.chatDirectAutoReplyJob.findUniqueOrThrow.mockImplementation(
      async ({ where }: any) => ({
        sourceMessageID: where.id.replace('job-', ''),
        attempts: 1,
      }),
    );
    prisma.chatDirectAutoReplyState.findUnique.mockImplementation(async () =>
      lastRepliedAt ? { lastRepliedAt } : null,
    );
    prisma.chatDirectAutoReplyState.upsert.mockImplementation(
      async ({ create }: any) => {
        lastRepliedAt = create.lastRepliedAt;
        return {};
      },
    );
    prisma.chatMessage.create.mockImplementation(async ({ data }: any) => {
      replies += 1;
      return {
        ...reply,
        ...data,
        id: `reply-${replies}`,
        createdAt: new Date(),
      };
    });
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
      const sql = query.join(' ');
      if (sql.includes('FROM "ChatConversation"')) {
        return [{ nextHeight: 4 }];
      }
      if (sql.includes('FROM "User"')) {
        return [
          {
            id: 'u2',
            nickname: 'Responder',
            avatarUrl: null,
            status: 'ACTIVE',
          },
        ];
      }
      return [{ now: new Date() }];
    });
    prisma.$transaction.mockImplementation((callback: any) => {
      const run = transactionTail.then(() => callback(prisma));
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });

    await Promise.all([
      processor.processMessage('source-a'),
      processor.processMessage('source-b'),
    ]);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
    expect(
      prisma.$queryRaw.mock.calls.filter(([query]) =>
        (query as TemplateStringsArray)
          .join(' ')
          .includes('FROM "ChatConversation"'),
      ),
    ).toHaveLength(2);
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(1);
  });
});
