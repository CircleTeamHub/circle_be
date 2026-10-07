import { ChatBurnSweeperService } from './chat-burn-sweeper.service';
import { Logger } from '@nestjs/common';
import { jobMetrics } from '../metrics/job-metrics';

describe('ChatBurnSweeperService', () => {
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    chatConversation: { findMany: jest.fn(), findUnique: jest.fn() },
    chatMessage: { findMany: jest.fn(), updateManyAndReturn: jest.fn() },
  };
  const media = {
    deleteObjects: jest.fn().mockResolvedValue(undefined),
    queueDeletions: jest.fn().mockResolvedValue(undefined),
    releaseNoteImportReferences: jest.fn().mockResolvedValue(undefined),
    drainPendingDeletions: jest.fn().mockResolvedValue(undefined),
  };
  const broadcast = {
    emitBurnedMessages: jest.fn().mockResolvedValue(undefined),
  };
  // 默认:没配 Redis(单实例)—— 租约拿不到协调、照常跑,游标只在内存里。
  const redis = {
    tryAcquireLease: jest.fn(),
    renewLease: jest.fn(),
    releaseLease: jest.fn(),
    getJsonMany: jest.fn(),
    setJson: jest.fn(),
    setJsonIfVersionMatches: jest.fn(),
  };
  const service = new ChatBurnSweeperService(
    prisma as never,
    media as never,
    broadcast as never,
    redis as never,
  );
  const makeService = () =>
    new ChatBurnSweeperService(
      prisma as never,
      media as never,
      broadcast as never,
      redis as never,
    );

  beforeEach(() => {
    jest.resetAllMocks();
    // RETURNING 带回触发器分配的序号:按 id 顺序编号。
    prisma.chatMessage.updateManyAndReturn.mockImplementation(
      (args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id, index) => ({ id, revision: index + 1 })),
        ),
    );
    media.deleteObjects.mockResolvedValue(undefined);
    media.releaseNoteImportReferences.mockResolvedValue(undefined);
    broadcast.emitBurnedMessages.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: 'locked' }]);
    redis.tryAcquireLease.mockResolvedValue(undefined);
    redis.renewLease.mockResolvedValue(true);
    redis.releaseLease.mockResolvedValue(undefined);
    redis.getJsonMany.mockResolvedValue(null);
    redis.setJson.mockResolvedValue(false);
    redis.setJsonIfVersionMatches.mockResolvedValue(true);
    // 每批删除前都重读当前策略(防「扫描中途策略被改长/关掉」)。
    prisma.chatConversation.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          conversationPolicies.get(where.id) ?? { burnDurationSec: null },
        ),
    );
  });

  /** conversationId → findUnique 返回的当前策略。 */
  const conversationPolicies = new Map<
    string,
    { burnDurationSec: number | null; burnStartedAt?: Date | null }
  >();

  it('advances beyond a persistent failure, retries after restart and wrap, and burns the recovered conversation', async () => {
    const conversations = Array.from({ length: 205 }, (_, index) => ({
      id: `rotation-${String(index).padStart(4, '0')}`,
      burnDurationSec: 60,
    }));
    const failedId = conversations[0].id;
    const remaining = new Set(conversations.map((row) => `message-${row.id}`));
    let broken = true;
    let failedAttempts = 0;
    let sharedCursor: string | null = null;
    redis.tryAcquireLease.mockResolvedValue('owner');
    redis.getJsonMany.mockImplementation(async () => [sharedCursor]);
    redis.setJsonIfVersionMatches.mockImplementation(
      async (_key, _lease, _owner, cursor) => {
        sharedCursor = cursor;
        return true;
      },
    );
    prisma.chatConversation.findMany.mockImplementation(
      async ({ where, take }) =>
        conversations
          .filter((row) => !where.id || row.id > where.id.gt)
          .slice(0, take),
    );
    prisma.chatConversation.findUnique.mockResolvedValue({
      burnDurationSec: 60,
    });
    prisma.chatMessage.findMany.mockImplementation(async ({ where }) => {
      const id = where.conversationID;
      if (id === failedId && broken) {
        failedAttempts++;
        throw new Error('SELECT private_chat_content secret-person');
      }
      const message = `message-${id}`;
      return remaining.has(message)
        ? [{ id: message, type: 'text', content: {} }]
        : [];
    });
    prisma.chatMessage.updateManyAndReturn.mockImplementation(
      async ({ where }) => {
        for (const id of where.id.in) remaining.delete(id);
        return where.id.in.map((id: string) => ({ id, revision: 1 }));
      },
    );
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const runs = jest.spyOn(jobMetrics, 'recordRun');
    try {
      await makeService().sweep();
      expect(sharedCursor).toBe(conversations[199].id);
      expect(remaining.has(`message-${conversations[199].id}`)).toBe(false);
      expect(failedAttempts).toBe(1);

      // A new process resumes the second page using the shared checkpoint.
      await makeService().sweep();
      expect(sharedCursor).toBeNull();
      expect(remaining).toEqual(new Set([`message-${failedId}`]));

      // Eligibility is durable in the burn policy and undeleted message rows.
      const restarted = makeService();
      await restarted.sweep();
      expect(failedAttempts).toBe(2);
      expect(sharedCursor).toBe(conversations[199].id);
      await restarted.sweep();
      expect(sharedCursor).toBeNull();
      broken = false;
      await makeService().sweep();
      expect(remaining.size).toBe(0);
      expect(broadcast.emitBurnedMessages).toHaveBeenCalledWith(failedId, [
        { id: `message-${failedId}`, revision: 1 },
      ]);
      expect(runs.mock.calls.map((call) => call[1])).toEqual([
        'failure',
        'success',
        'failure',
        'success',
        'success',
      ]);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'chat_burn_sweep_failed',
          operation: 'conversation',
          conversationId: failedId,
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /SELECT|private_chat_content|secret-person/,
      );
    } finally {
      log.mockRestore();
      runs.mockRestore();
    }
  });

  it('keeps the previous checkpoint and redacts a scan failure', async () => {
    prisma.chatConversation.findMany.mockRejectedValue(
      new Error('SELECT private_messages secret-person'),
    );
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const runs = jest.spyOn(jobMetrics, 'recordRun');
    try {
      await makeService().sweep();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'chat_burn_sweep_failed',
          operation: 'scan',
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /SELECT|private_messages|secret-person/,
      );
      expect(runs).toHaveBeenCalledWith(
        'chat_burn_sweeper',
        'failure',
        expect.any(Number),
        undefined,
      );
      expect(redis.setJsonIfVersionMatches).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      runs.mockRestore();
    }
  });

  // 触发器会去更新会话计数器:先锁一批消息行再等会话行,与「先锁会话行再改消息」
  // 的编辑/回应并发就会交叉死锁。所以批事务的第一条语句必须是会话行锁。
  it('locks the conversation row before tombstoning a batch', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: { text: 'old' } },
    ]);

    await service.sweep();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.chatMessage.updateManyAndReturn.mock.invocationCallOrder[0],
    );
  });

  it('soft-deletes expired rows, clears content and deletes media objects', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 3600 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 3600 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: { text: 'old' } },
      {
        id: 'm2',
        type: 'image',
        content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u1/a.t.jpg' },
      },
    ]);

    await service.sweep();

    const [[query]] = prisma.chatMessage.findMany.mock.calls as [
      [{ where: { createdAt: { lt: Date } } }],
    ];
    // 截止 = 现在 - burnDurationSec,允许极小的执行耗时误差。
    expect(
      Math.abs(Date.now() - 3600_000 - query.where.createdAt.lt.getTime()),
    ).toBeLessThan(5_000);
    // 软删 + 清 content:height 坐标保留,读路径靠 deleted 过滤。
    expect(prisma.chatMessage.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] }, deleted: false },
      // contentHistory 一起清:只清 content 的话,编辑过的旧正文还完整留在库里。
      data: {
        deleted: true,
        deletedAt: expect.any(Date),
        content: {},
        contentHistory: [],
      },
      select: { id: true, revision: true },
    });
    // 只软删不删对象 = 焚毁只焚了个寂寞。
    expect(media.deleteObjects).toHaveBeenCalledWith([
      'chat/u1/a.jpg',
      'chat/u1/a.t.jpg',
    ]);
  });

  describe('with several instances', () => {
    it('stops subsequent conversations after a caught failure loses the lease', async () => {
      jest.useFakeTimers();
      redis.tryAcquireLease.mockResolvedValue('owner');
      redis.renewLease.mockResolvedValue(false);
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'lost-first', burnDurationSec: 60 },
        { id: 'lost-second', burnDurationSec: 60 },
      ]);
      prisma.chatConversation.findUnique.mockResolvedValue({
        burnDurationSec: 60,
      });
      let fail!: (error: Error) => void;
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      prisma.chatMessage.findMany.mockImplementationOnce(() => {
        notifyStarted();
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      });
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const fresh = makeService();
      const round = fresh.sweep();
      try {
        await started;
        await jest.advanceTimersByTimeAsync(41_000);
        fail(new Error('failed query'));
        await round;
        expect(prisma.chatConversation.findUnique).toHaveBeenCalledTimes(1);
        expect(redis.setJsonIfVersionMatches).not.toHaveBeenCalled();
        expect((fresh as any).cursor).toBeNull();
      } finally {
        fail(new Error('cleanup'));
        await round;
        log.mockRestore();
        jest.useRealTimers();
      }
    });

    it('does not advance a full page containing a failure when its checkpoint token is rejected', async () => {
      redis.tryAcquireLease.mockResolvedValue('owner');
      redis.getJsonMany.mockResolvedValue(['previous-page']);
      redis.setJsonIfVersionMatches.mockResolvedValue(false);
      const conversations = Array.from({ length: 200 }, (_, index) => ({
        id: `z-page-${String(index).padStart(4, '0')}`,
        burnDurationSec: 60,
      }));
      prisma.chatConversation.findMany.mockResolvedValue(conversations);
      prisma.chatConversation.findUnique
        .mockResolvedValue({ burnDurationSec: 60 })
        .mockRejectedValueOnce(new Error('single conversation failure'));
      prisma.chatMessage.findMany.mockResolvedValue([]);
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      try {
        const fresh = makeService();
        await fresh.sweep();
        expect(prisma.chatConversation.findUnique).toHaveBeenCalledTimes(200);
        expect(redis.setJsonIfVersionMatches).toHaveBeenCalledWith(
          'job-cursor:chat_burn_sweeper',
          'job-lease:chat_burn_sweeper',
          'owner',
          conversations[199].id,
          expect.any(Number),
        );
        expect((fresh as any).cursor).toBe('previous-page');
        expect(redis.setJson).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });

    it('skips the round while another instance holds the lease', async () => {
      redis.tryAcquireLease.mockResolvedValue(null);

      await service.sweep();

      expect(redis.tryAcquireLease).toHaveBeenCalledWith(
        'job-lease:chat_burn_sweeper',
        expect.any(Number),
      );
      expect(prisma.chatConversation.findMany).not.toHaveBeenCalled();
    });

    it('releases its lease once the round is done', async () => {
      redis.tryAcquireLease.mockResolvedValue('lease-token');
      prisma.chatConversation.findMany.mockResolvedValue([]);

      await service.sweep();

      expect(redis.releaseLease).toHaveBeenCalledWith(
        'job-lease:chat_burn_sweeper',
        'lease-token',
      );
    });

    // 游标只在本机内存里的话,换了实例拿到租约就从头扫,后面的会话轮不到。
    it('continues from the cursor shared by every instance', async () => {
      redis.tryAcquireLease.mockResolvedValue('lease-token');
      redis.getJsonMany.mockResolvedValue(['conv-100']);
      prisma.chatConversation.findMany.mockResolvedValue([]);

      await service.sweep();

      expect(prisma.chatConversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { gt: 'conv-100' } }),
        }),
      );
      // 这一轮没扫满,下一轮从头开始。
      expect(redis.setJsonIfVersionMatches).toHaveBeenCalledWith(
        'job-cursor:chat_burn_sweeper',
        'job-lease:chat_burn_sweeper',
        'lease-token',
        null,
        expect.any(Number),
      );
    });

    it('stops a pending deletion and leaves its cursor replayable when renewal fails', async () => {
      jest.useFakeTimers();
      redis.tryAcquireLease.mockResolvedValue('owner');
      redis.renewLease.mockResolvedValue(false);
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-loss', burnDurationSec: 60 },
      ]);
      conversationPolicies.set('conv-loss', { burnDurationSec: 60 });
      let finish!: (rows: unknown[]) => void;
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      prisma.chatMessage.findMany.mockImplementation(() => {
        notifyStarted();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const round = service.sweep();
      try {
        await started;
        await jest.advanceTimersByTimeAsync(41_000);
        finish([{ id: 'm1', type: 'text', content: {} }]);
        await round;
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.chatMessage.updateManyAndReturn).not.toHaveBeenCalled();
        expect(redis.setJsonIfVersionMatches).not.toHaveBeenCalled();
      } finally {
        finish([]);
        await round;
        jest.useRealTimers();
      }
    });

    it('keeps its local cursor when the atomic shared checkpoint rejects its token', async () => {
      redis.tryAcquireLease.mockResolvedValue('owner');
      redis.getJsonMany.mockResolvedValue(['conv-100']);
      redis.setJsonIfVersionMatches.mockResolvedValue(false);
      prisma.chatConversation.findMany.mockResolvedValue([]);
      const fresh = new ChatBurnSweeperService(
        prisma as never,
        media as never,
        broadcast as never,
        redis as never,
      );
      await fresh.sweep();
      expect((fresh as any).cursor).toBe('conv-100');
      expect(redis.setJson).not.toHaveBeenCalled();
    });

    it('does not tombstone or delete media after losing the lease while waiting for a row lock', async () => {
      jest.useFakeTimers();
      redis.tryAcquireLease.mockResolvedValue('owner');
      redis.renewLease.mockResolvedValue(false);
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-lock', burnDurationSec: 60 },
      ]);
      conversationPolicies.set('conv-lock', { burnDurationSec: 60 });
      prisma.chatMessage.findMany.mockResolvedValue([
        { id: 'm1', type: 'image', content: { key: 'chat/u1/photo.jpg' } },
      ]);
      let finish!: (rows: unknown[]) => void;
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      prisma.$queryRaw.mockImplementationOnce(() => {
        notifyStarted();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const round = service.sweep();
      try {
        await started;
        await jest.advanceTimersByTimeAsync(41_000);
        finish([{ id: 'conv-lock' }]);
        await round;
        expect(prisma.chatMessage.updateManyAndReturn).not.toHaveBeenCalled();
        expect(media.queueDeletions).not.toHaveBeenCalled();
        expect(media.deleteObjects).not.toHaveBeenCalled();
        expect(redis.setJsonIfVersionMatches).not.toHaveBeenCalled();
      } finally {
        finish([]);
        await round;
        jest.useRealTimers();
      }
    });

    // 租约过期后两个实例可能同时扫到同一批:已经烧掉的行不能再改一遍、再播一遍。
    it('never tombstones a row another sweep already burned', async () => {
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-1', burnDurationSec: 60 },
      ]);
      conversationPolicies.set('conv-1', { burnDurationSec: 60 });
      prisma.chatMessage.findMany.mockResolvedValueOnce([
        { id: 'm1', type: 'text', content: { text: 'old' } },
      ]);
      prisma.chatMessage.updateManyAndReturn.mockResolvedValue([]);

      await service.sweep();

      expect(prisma.chatMessage.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['m1'] }, deleted: false },
        }),
      );
      expect(broadcast.emitBurnedMessages).not.toHaveBeenCalled();
    });
  });

  it('does nothing when no conversation has burn enabled', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([]);
    await service.sweep();
    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('never tombstones messages from before the current burn activation', async () => {
    const burnStartedAt = new Date('2026-09-14T10:00:00.000Z');
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60, burnStartedAt },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60, burnStartedAt });
    prisma.chatMessage.findMany.mockResolvedValueOnce([]);

    await service.sweep();

    expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: burnStartedAt,
            lt: expect.any(Date),
          },
        }),
      }),
    );
  });

  it('releases shared note-import references instead of deleting them directly', async () => {
    const shared = 'chat/u1/note-import/shared.jpg';
    const owned = 'chat/u1/owned.jpg';
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'image', content: { key: shared, thumbKey: owned } },
    ]);

    await service.sweep();

    expect(media.releaseNoteImportReferences).toHaveBeenCalledWith(
      prisma,
      ['m1'],
      [shared],
    );
    expect(media.deleteObjects).toHaveBeenCalledWith([owned]);
    expect(media.queueDeletions).toHaveBeenCalledWith(prisma, [owned]);
  });

  it('stops the per-conversation loop on a short batch', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: {} },
    ]);

    await service.sweep();
    // 一批就删完(< SWEEP_BATCH):不再发起第二次查询。
    expect(prisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('stops deleting when the burn policy is turned off mid-sweep', async () => {
    // 进入本轮时是 60 秒,但批与批之间用户把焚毁关掉了 —— 拿旧 cutoff 接着删,
    // 删掉的就是用户刚决定要留下的消息,而且不可逆。
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: null });

    await service.sweep();

    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.chatMessage.updateManyAndReturn).not.toHaveBeenCalled();
  });

  // 服务端把正文清空了,在线设备却无从得知 —— 本地缓存、冷启动水合与本地 FTS
  // 仍能端出本该烧掉的内容。每批墓碑提交后告诉在座成员烧掉了哪些 id。
  it('announces the burned ids only after their tombstones commit', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: { text: 'old' } },
      { id: 'm2', type: 'text', content: { text: 'older' } },
    ]);

    await service.sweep();

    expect(broadcast.emitBurnedMessages).toHaveBeenCalledTimes(1);
    expect(broadcast.emitBurnedMessages).toHaveBeenCalledWith('conv-1', [
      { id: 'm1', revision: 1 },
      { id: 'm2', revision: 2 },
    ]);
    expect(
      prisma.chatMessage.updateManyAndReturn.mock.invocationCallOrder[0],
    ).toBeLessThan(broadcast.emitBurnedMessages.mock.invocationCallOrder[0]);
  });

  // 事务回滚了却已经播出去,对端会删掉服务端其实还留着的消息。
  it('announces nothing when the tombstone transaction fails', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([
      { id: 'm1', type: 'text', content: {} },
    ]);
    prisma.$transaction.mockRejectedValueOnce(
      new Error('serialization failure'),
    );

    await service.sweep();

    expect(broadcast.emitBurnedMessages).not.toHaveBeenCalled();
  });

  it('announces nothing when no message has expired', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    prisma.chatMessage.findMany.mockResolvedValueOnce([]);

    await service.sweep();

    expect(broadcast.emitBurnedMessages).not.toHaveBeenCalled();
  });

  it('announces each committed batch on its own', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    const fullBatch = Array.from({ length: 500 }, (_, i) => ({
      id: `m${i}`,
      type: 'text',
      content: {},
    }));
    prisma.chatMessage.findMany
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce([{ id: 'tail', type: 'text', content: {} }]);

    await service.sweep();

    expect(broadcast.emitBurnedMessages).toHaveBeenCalledTimes(2);
    expect(broadcast.emitBurnedMessages).toHaveBeenNthCalledWith(
      1,
      'conv-1',
      fullBatch.map((row, index) => ({ id: row.id, revision: index + 1 })),
    );
    expect(broadcast.emitBurnedMessages).toHaveBeenNthCalledWith(2, 'conv-1', [
      { id: 'tail', revision: 1 },
    ]);
  });

  it('keeps sweeping other conversations when an announcement fails', async () => {
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-1', burnDurationSec: 60 },
      { id: 'conv-2', burnDurationSec: 60 },
    ]);
    conversationPolicies.set('conv-1', { burnDurationSec: 60 });
    conversationPolicies.set('conv-2', { burnDurationSec: 60 });
    prisma.chatMessage.findMany
      .mockResolvedValueOnce([{ id: 'm1', type: 'text', content: {} }])
      .mockResolvedValueOnce([{ id: 'm2', type: 'text', content: {} }]);
    broadcast.emitBurnedMessages.mockRejectedValueOnce(
      new Error('adapter down'),
    );

    await service.sweep();

    expect(prisma.chatMessage.updateManyAndReturn).toHaveBeenCalledTimes(2);
    expect(broadcast.emitBurnedMessages).toHaveBeenLastCalledWith('conv-2', [
      { id: 'm2', revision: 1 },
    ]);
  });
});
