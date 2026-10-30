import { NoteStatusFanoutOutboxProcessor } from './note-status-fanout-outbox.processor';

const pendingJob = (overrides: Record<string, unknown> = {}) => ({
  rootNoteID: 'source-note',
  status: 'PENDING',
  stage: 'OWNERS',
  generation: 3,
  noteCursor: null,
  chatConversationCursor: null,
  chatUserCursor: null,
  attempts: 0,
  lockedAt: null,
  ...overrides,
});

const sourceState = {
  id: 'source-note',
  status: 'ACTIVE',
  available: true,
  workStatus: 'WORKING',
};

function createHarness(
  job = pendingJob(),
  assistant = { sendNoteStatusAlert: jest.fn().mockResolvedValue(undefined) },
) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    noteStatusFanoutOutbox: {
      findMany: jest.fn().mockResolvedValue([job]),
      updateMany,
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    note: {
      findUnique: jest.fn().mockResolvedValue(sourceState),
      findMany: jest.fn().mockResolvedValue([]),
    },
    assistantSubscription: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const realtime = {
    safeBroadcastAll: jest.fn(async (operations: Array<() => Promise<void>>) =>
      Promise.all(operations.map((operation) => operation())),
    ),
    broadcastNoteSourceStatusChanged: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    realtime,
    processor: new NoteStatusFanoutOutboxProcessor(
      prisma as any,
      realtime as any,
      assistant as any,
    ),
    assistant,
  };
}

describe('NoteStatusFanoutOutboxProcessor', () => {
  it('sends one assistant alert to collected-note owners when a source is unlisted', async () => {
    const assistant = {
      sendNoteStatusAlert: jest.fn().mockResolvedValue(undefined),
    };
    const { prisma, processor } = createHarness(pendingJob(), assistant);
    prisma.note.findUnique.mockResolvedValue({
      id: 'source-note',
      ownerID: 'owner-1',
      title: '北京租房攻略',
      status: 'UNLISTED',
      available: false,
      workStatus: null,
      updatedAt: new Date('2026-10-29T12:00:00.000Z'),
    });
    prisma.note.findMany.mockResolvedValue([
      { id: 'source-note', ownerID: 'owner-1' },
      { id: 'copy-note', ownerID: 'viewer-1' },
    ]);
    prisma.assistantSubscription.findMany.mockResolvedValue([
      { userID: 'viewer-1' },
    ]);

    await processor.processPending();

    expect(assistant.sendNoteStatusAlert).toHaveBeenCalledWith('viewer-1', {
      sourceNoteId: 'source-note',
      title: '北京租房攻略',
      status: 'UNLISTED',
      changedAt: '2026-10-29T12:00:00.000Z',
    });
  });

  it('skips assistant alerts when the recipient has not opted in', async () => {
    const assistant = {
      sendNoteStatusAlert: jest.fn().mockResolvedValue(undefined),
    };
    const { prisma, processor } = createHarness(pendingJob(), assistant);
    prisma.note.findUnique.mockResolvedValue({
      id: 'source-note',
      ownerID: 'owner-1',
      title: '北京租房攻略',
      status: 'UNLISTED',
      available: false,
      workStatus: null,
      updatedAt: new Date('2026-10-29T12:00:00.000Z'),
    });
    prisma.note.findMany.mockResolvedValue([
      { id: 'source-note', ownerID: 'owner-1' },
      { id: 'copy-note', ownerID: 'viewer-1' },
    ]);

    await processor.processPending();

    expect(prisma.assistantSubscription.findMany).toHaveBeenCalledWith({
      where: {
        userID: { in: ['viewer-1'] },
        enabled: true,
        noteStatusAlerts: true,
      },
      select: { userID: true },
      distinct: ['userID'],
    });
    expect(assistant.sendNoteStatusAlert).not.toHaveBeenCalled();
  });

  it('broadcasts only one bounded owner page and persists its cursor', async () => {
    const { prisma, realtime, processor } = createHarness();
    prisma.note.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `note-${String(index).padStart(3, '0')}`,
        ownerID: `owner-${index}`,
      })),
    );

    await processor.processPending();

    expect(prisma.note.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ id: 'source-note' }, { rootSourceNoteID: 'source-note' }],
      },
      orderBy: { id: 'asc' },
      take: 101,
      select: { id: true, ownerID: true },
    });
    expect(realtime.broadcastNoteSourceStatusChanged).toHaveBeenCalledTimes(
      100,
    );
    expect(prisma.noteStatusFanoutOutbox.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        rootNoteID: 'source-note',
        generation: 3,
        leaseToken: expect.any(String),
        status: 'PROCESSING',
      }),
      data: expect.objectContaining({
        status: 'PENDING',
        stage: 'OWNERS',
        noteCursor: 'note-099',
        lockedAt: null,
        leaseToken: null,
      }),
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('pages active chat members through indexed source provenance and a composite cursor', async () => {
    const { prisma, realtime, processor } = createHarness(
      pendingJob({
        stage: 'CHAT_MEMBERS',
        chatConversationCursor: 'conversation-previous',
        chatUserCursor: 'user-previous',
      }),
    );
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        conversationID: `conversation-${String(index).padStart(3, '0')}`,
        userID: `user-${String(index).padStart(3, '0')}`,
      })),
    );

    await processor.processPending();

    const sql = prisma.$queryRaw.mock.calls[0][0].join(' ');
    expect(sql).toContain('"sourceNoteID"');
    expect(sql).toContain('"leftAt" IS NULL');
    expect(sql).toContain('LIMIT');
    expect(realtime.broadcastNoteSourceStatusChanged).toHaveBeenCalledTimes(
      100,
    );
    expect(prisma.noteStatusFanoutOutbox.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        rootNoteID: 'source-note',
        generation: 3,
        leaseToken: expect.any(String),
      }),
      data: expect.objectContaining({
        status: 'PENDING',
        stage: 'CHAT_MEMBERS',
        chatConversationCursor: 'conversation-099',
        chatUserCursor: 'user-099',
      }),
    });
  });

  it('deletes a completed job only under the claimed generation and lease', async () => {
    const { prisma, processor } = createHarness(
      pendingJob({ stage: 'CHAT_MEMBERS' }),
    );
    prisma.$queryRaw.mockResolvedValue([
      { conversationID: 'conversation-1', userID: 'recipient-1' },
    ]);

    await processor.processPending();

    const leaseToken =
      prisma.noteStatusFanoutOutbox.updateMany.mock.calls[0][0].data.leaseToken;
    expect(prisma.noteStatusFanoutOutbox.deleteMany).toHaveBeenCalledWith({
      where: {
        rootNoteID: 'source-note',
        generation: 3,
        leaseToken,
        status: 'PROCESSING',
      },
    });
  });

  it('stops when a newer mutation replaces the claimed generation', async () => {
    const { prisma, processor } = createHarness();
    prisma.note.findMany.mockResolvedValue([
      { id: 'source-note', ownerID: 'u1' },
    ]);
    prisma.noteStatusFanoutOutbox.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await processor.processPending();

    expect(prisma.noteStatusFanoutOutbox.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.noteStatusFanoutOutbox.deleteMany).not.toHaveBeenCalled();
  });

  it('reclaims a stale processing job only with its observed lock', async () => {
    const lockedAt = new Date('2026-10-20T00:00:00.000Z');
    const { prisma, processor } = createHarness(
      pendingJob({ status: 'PROCESSING', lockedAt }),
    );

    await processor.processPending();

    expect(prisma.noteStatusFanoutOutbox.updateMany.mock.calls[0][0]).toEqual({
      where: {
        rootNoteID: 'source-note',
        generation: 3,
        status: 'PROCESSING',
        lockedAt,
      },
      data: {
        status: 'PROCESSING',
        leaseToken: expect.any(String),
        lockedAt: expect.any(Date),
      },
    });
  });

  it('broadcasts a deletion when the root row was permanently purged', async () => {
    const { prisma, realtime, processor } = createHarness(
      pendingJob({ stage: 'CHAT_MEMBERS' }),
    );
    prisma.note.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([
      { conversationID: 'conversation-1', userID: 'recipient-1' },
    ]);

    await processor.processPending();

    expect(realtime.broadcastNoteSourceStatusChanged).toHaveBeenCalledWith(
      'recipient-1',
      {
        sourceNoteId: 'source-note',
        workStatus: null,
        status: 'DELETED',
        available: false,
      },
    );
  });

  it('retries a failed page with capped backoff under the same generation', async () => {
    const { prisma, processor } = createHarness();
    prisma.note.findUnique.mockRejectedValue(new Error('database unavailable'));

    await processor.processPending();

    expect(prisma.noteStatusFanoutOutbox.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        rootNoteID: 'source-note',
        generation: 3,
        leaseToken: expect.any(String),
        status: 'PROCESSING',
      }),
      data: expect.objectContaining({
        status: 'FAILED',
        attempts: { increment: 1 },
        nextAttemptAt: expect.any(Date),
        lockedAt: null,
        leaseToken: null,
      }),
    });
  });
});
