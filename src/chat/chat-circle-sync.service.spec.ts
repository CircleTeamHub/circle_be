import { ChatCircleSyncService } from './chat-circle-sync.service';
import { LoggerService } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { createWinstonOptions } from '../logging/winston-options';
import { RedisService } from '../redis/redis.service';

describe('ChatCircleSyncService', () => {
  const prisma = {
    chatCircleSyncRetry: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    circle: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    circleMember: { findMany: jest.fn() },
    chatConversation: { findUnique: jest.fn(), create: jest.fn() },
    chatMember: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
    // 新座位的已读水位要落在当前最高 height 上,不能是默认 0。
    chatMessage: {
      aggregate: jest.fn().mockResolvedValue({ _max: { height: null } }),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    // 同圈对账串行化的 advisory lock(多实例下防 joined 事件与系统提示重复)。
    $executeRaw: jest.fn(),
  };
  const broadcast = {
    joinUserToConversation: jest.fn(),
    removeUserFromConversation: jest.fn(),
    emitConversationChange: jest.fn(),
    disconnectUserSockets: jest.fn(),
  };
  const systemMessage = { emit: jest.fn().mockResolvedValue(undefined) };
  const groupEvents = {
    record: jest.fn().mockResolvedValue(undefined),
    recordInTx: jest.fn().mockResolvedValue(undefined),
  };

  // 默认:没配 Redis(单实例),租约协调不可用 → 照常跑。
  const redis = {
    tryAcquireLease: jest.fn(),
    renewLease: jest.fn(),
    releaseLease: jest.fn(),
    getJsonMany: jest.fn(),
    setJson: jest.fn(),
    setJsonIfVersionMatches: jest.fn(),
  };
  const service = new ChatCircleSyncService(
    prisma as never,
    broadcast as never,
    systemMessage as never,
    groupEvents as never,
    redis as never,
  );
  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatCircleSyncRetry.findMany.mockResolvedValue([]);
    prisma.chatCircleSyncRetry.createMany.mockResolvedValue({ count: 1 });
    prisma.chatCircleSyncRetry.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatCircleSyncRetry.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(runTx as never);
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.chatMember.createMany.mockResolvedValue({ count: 0 });
    prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
    broadcast.joinUserToConversation.mockResolvedValue(undefined);
    broadcast.removeUserFromConversation.mockResolvedValue(undefined);
    broadcast.disconnectUserSockets.mockResolvedValue(undefined);
    systemMessage.emit.mockResolvedValue(undefined);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    redis.tryAcquireLease.mockResolvedValue(undefined);
    redis.renewLease.mockResolvedValue(true);
    redis.releaseLease.mockResolvedValue(undefined);
    redis.getJsonMany.mockResolvedValue(null);
    redis.setJson.mockResolvedValue(false);
    redis.setJsonIfVersionMatches.mockResolvedValue(true);
  });

  describe('failure log privacy', () => {
    let logger: winston.Logger;
    let sync: ChatCircleSyncService;
    let lines: string[];
    const privateFailure = () =>
      new Error(
        'SELECT private_chat_content FROM messages WHERE nickname = private-person',
      );

    beforeEach(() => {
      lines = [];
      const options = createWinstonOptions(
        { get: (key) => ({ LOG_ON: 'true', LOG_FILE_ON: 'false' })[key] },
        'production',
      );
      const transport = options
        .transports[0] as winston.transports.ConsoleTransportInstance;
      jest.spyOn(transport, 'log').mockImplementation((info, callback) => {
        lines.push(info[Symbol.for('message')]);
        callback?.();
      });
      logger = winston.createLogger(options);
      sync = new ChatCircleSyncService(
        prisma as never,
        broadcast as never,
        systemMessage as never,
        groupEvents as never,
        redis as never,
      );
      (sync as unknown as { logger: LoggerService }).logger =
        WinstonModule.createLogger({ instance: logger });
    });

    afterEach(() => logger.close());

    it('keeps join and leave failures private while preserving membership broadcasts', async () => {
      prisma.circle.findUnique.mockResolvedValue({
        id: 'circle-1',
        deleted: false,
        adminState: 'ACTIVE',
      });
      prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      prisma.circleMember.findMany.mockResolvedValue([{ userID: 'u1' }]);
      prisma.chatMember.findMany.mockResolvedValue([
        { userID: 'u2', leftAt: null },
      ]);
      broadcast.joinUserToConversation.mockRejectedValueOnce(privateFailure());
      broadcast.removeUserFromConversation.mockRejectedValueOnce(
        privateFailure(),
      );

      await expect(sync.ensureCircleConversation('circle-1')).resolves.toBe(
        'conv-1',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lines.join('')).not.toMatch(
        /private_chat_content|private-person|SELECT/,
      );
      const records = lines.map((line) => JSON.parse(line));
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'chat_circle_sync_failed',
            operation: 'join_room',
            userId: 'u1',
          }),
          expect.objectContaining({
            event: 'chat_circle_sync_failed',
            operation: 'leave_room',
            userId: 'u2',
          }),
        ]),
      );
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ kind: 'joined' }),
      );
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith(
        'u2',
        expect.objectContaining({ kind: 'removed' }),
      );
    });

    it('keeps detach and notice errors private without skipping disconnect or removal', async () => {
      broadcast.removeUserFromConversation.mockRejectedValueOnce(
        privateFailure(),
      );
      broadcast.disconnectUserSockets.mockRejectedValueOnce(privateFailure());
      systemMessage.emit.mockRejectedValueOnce(privateFailure());
      await expect(
        sync.detachSeat('u1', 'conv-1', 'removed'),
      ).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(lines.join('')).not.toMatch(
        /private_chat_content|private-person|SELECT/,
      );
      const records = lines.map((line) => JSON.parse(line));
      for (const operation of [
        'detach_seat',
        'evict_sockets',
        'member_left_notice',
      ]) {
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: 'chat_circle_sync_failed',
              operation,
            }),
          ]),
        );
      }
      expect(broadcast.disconnectUserSockets).toHaveBeenCalledWith('u1');
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ kind: 'removed' }),
      );
    });

    it('records a fixed scan failure event without exposing the database exception', async () => {
      prisma.$queryRaw.mockRejectedValueOnce(
        Object.assign(privateFailure(), { code: 'P2024' }),
      );
      await expect(sync.reconcileRecent()).resolves.toBeUndefined();
      expect(lines.join('')).not.toMatch(
        /private_chat_content|private-person|SELECT/,
      );
      expect(lines.map((line) => JSON.parse(line))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'chat_circle_sync_failed',
            operation: 'reconcile_scan',
            errorCode: 'P2024',
          }),
        ]),
      );
    });
  });

  it('default-denies a dismissed circle and clears every seat', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'DISMISSED',
    });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u1' },
      { userID: 'u2' },
    ]);

    const id = await service.ensureCircleConversation('circle-1');

    expect(id).toBeNull();
    // 照常对账的话,这一轮会把 DISMISS 时设的 leftAt 清回去,群聊自己重新开门。
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      data: { leftAt: expect.any(Date) },
    });
    expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    // 被清座的人要收到个人事件,否则 UI 一直停在已解散的群里。
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'removed',
      conversationId: 'conv-1',
      userId: 'u1',
    });
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u2', {
      kind: 'removed',
      conversationId: 'conv-1',
      userId: 'u2',
    });
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('default-denies a soft-deleted circle', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: true,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue(null);

    await expect(
      service.ensureCircleConversation('circle-1'),
    ).resolves.toBeNull();
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('rechecks circle state after the lock before re-seating members', async () => {
    prisma.circle.findUnique
      .mockResolvedValueOnce({
        id: 'circle-1',
        deleted: false,
        adminState: 'ACTIVE',
      })
      .mockResolvedValueOnce({
        id: 'circle-1',
        deleted: true,
        adminState: 'ACTIVE',
      });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.chatMember.findMany.mockResolvedValue([{ userID: 'u1' }]);

    await expect(
      service.ensureCircleConversation('circle-1'),
    ).resolves.toBeNull();
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      data: { leftAt: expect.any(Date) },
    });
    expect(prisma.chatMember.createMany).not.toHaveBeenCalled();
  });

  it('creates the conversation and seats every ACTIVE member', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue(null);
    prisma.chatConversation.create.mockResolvedValue({ id: 'conv-1' });
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'u1' },
      { userID: 'u2' },
    ]);
    prisma.chatMember.findMany.mockResolvedValue([]);

    const id = await service.ensureCircleConversation('circle-1');

    expect(id).toBe('conv-1');
    expect(prisma.chatConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: 'GROUP',
          circleID: 'circle-1',
          membersCanViewProfiles: false,
          membersCanViewRoster: false,
        },
      }),
    );
    expect(prisma.chatMember.createMany).toHaveBeenCalledWith({
      data: [
        { conversationID: 'conv-1', userID: 'u1', lastReadHeight: 0 },
        { conversationID: 'conv-1', userID: 'u2', lastReadHeight: 0 },
      ],
      skipDuplicates: true,
    });
    // 新入座成员的在线 socket 被拉入会话房。
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'u2',
      'conv-1',
    );
    // 个人事件让会话即刻出现在列表里,不必等下一次全量拉取。
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'joined',
      conversationId: 'conv-1',
      userId: 'u1',
    });
  });

  it('revives left seats and retires seats of members no longer active', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.circleMember.findMany.mockResolvedValue([{ userID: 'u1' }]);
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u1', leftAt: new Date() }, // 重新入圈:复活
      { userID: 'u2', leftAt: null }, // 已被踢:离座
    ]);

    await service.ensureCircleConversation('circle-1');

    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userID: { in: ['u1'] },
          leftAt: { not: null },
        }),
        // 复活座位同时把水位推到当前高度:离座期间的消息本就与他无关,
        // 留着旧水位会让重新入群的人一进来就背一堆"未读"。
        // joinedAt 同步刷新 —— 逐条已读回执按它排掉「入群前的消息」。
        data: {
          leftAt: null,
          lastReadHeight: 0,
          joinedAt: expect.any(Date) as Date,
        },
      }),
    );
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userID: { notIn: ['u1'] },
          leftAt: null,
        }),
        data: { leftAt: expect.any(Date) },
      }),
    );
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
      'u2',
      'conv-1',
    );
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'joined',
      conversationId: 'conv-1',
      userId: 'u1',
    });
    // 对账分不清主动退出还是被移出,统一按 removed 下发(UI 行为一致:移除会话)。
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u2', {
      kind: 'removed',
      conversationId: 'conv-1',
      userId: 'u2',
    });
  });

  // 落 schema 默认的 0 的话,新成员一进老群就背着全部历史的未读数(可能几万),
  // 红点永远清不掉 —— 他加入之前的消息本来就不该算他头上。
  it('seats new members at the current message height, not at zero', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
    prisma.circleMember.findMany.mockResolvedValue([{ userID: 'newcomer' }]);
    prisma.chatMember.findMany.mockResolvedValue([]);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 4321 } });

    await service.ensureCircleConversation('circle-1');

    expect(prisma.chatMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          conversationID: 'conv-1',
          userID: 'newcomer',
          lastReadHeight: 4321,
        },
      ],
      skipDuplicates: true,
    });
  });

  // 对账的 toRemove 只挑「座位仍 leftAt=null 却已不在 ACTIVE 名单」的人,而
  // releaseSeatInTx 在事务里就把 leftAt 置好了 —— 等对账跑到时已不满足条件;
  // 何况 CircleMember 行已被删除,updatedAt 窗口根本扫不到这个圈子。结果就是
  // 真实的退群/踢人一条提示都没有。提示必须由删除钩子自己补。
  it('emits a member-left notice when a deletion hook releases a seat', async () => {
    await service.detachSeat('u1', 'conv-1', 'removed');

    expect(systemMessage.emit).toHaveBeenCalledWith('conv-1', {
      kind: 'member-left',
    });
    expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    // 被踢者本人要立即收到 removed:socket 离房只是收不到消息,UI 还得靠这条收走会话。
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'removed',
      conversationId: 'conv-1',
      userId: 'u1',
    });
    // 顺序要紧:离房必须先完成。反过来的话,离房内部还在 await fetchSockets
    // 时广播到会话房的消息,被移出的人照样收得到。
    expect(
      broadcast.removeUserFromConversation.mock.invocationCallOrder[0],
    ).toBeLessThan(
      broadcast.emitConversationChange.mock.invocationCallOrder[0],
    );
  });

  it('disconnects the socket when the room leave fails', async () => {
    // 断连接帮助旧会话房尽快收敛；消息隐私本身由每次广播的 active-seat
    // 过滤保证，不再把这个无 adapter ack 的动作当授权边界。
    broadcast.removeUserFromConversation.mockRejectedValueOnce(
      new Error('adapter down'),
    );

    await service.detachSeat('u1', 'conv-1', 'removed');

    expect(broadcast.disconnectUserSockets).toHaveBeenCalledWith('u1');
  });

  it('waits for failed-leave disconnect fallback before completing manager detach', async () => {
    let finishDisconnect!: () => void;
    broadcast.removeUserFromConversation.mockRejectedValueOnce(
      new Error('adapter down'),
    );
    broadcast.disconnectUserSockets.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );

    let resolved = false;
    const detach = service
      .detachSeat('u1', 'conv-1', 'removed', false)
      .then(() => {
        resolved = true;
      });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(broadcast.emitConversationChange).not.toHaveBeenCalled();
    finishDisconnect();
    await detach;

    expect(broadcast.emitConversationChange).toHaveBeenCalled();
    expect(systemMessage.emit).not.toHaveBeenCalled();
  });

  it('tells the leaver own devices with kind left instead of removed', async () => {
    await service.detachSeat('u1', 'conv-1', 'left');

    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'left',
      conversationId: 'conv-1',
      userId: 'u1',
    });
    // 群里其他人看到的灰条措辞不区分主动被动,保持 member-left。
    expect(systemMessage.emit).toHaveBeenCalledWith('conv-1', {
      kind: 'member-left',
    });
  });

  it('can detach a manager-removed member without emitting a duplicate member-left notice', async () => {
    await service.detachSeat('u1', 'conv-1', 'removed', false);

    expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
      'u1',
      'conv-1',
    );
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'removed',
      conversationId: 'conv-1',
      userId: 'u1',
    });
    expect(systemMessage.emit).not.toHaveBeenCalled();
  });

  it('does not block manager removal when neither best-effort room cleanup command dispatches', async () => {
    broadcast.removeUserFromConversation.mockRejectedValueOnce(
      new Error('adapter down'),
    );
    broadcast.disconnectUserSockets.mockRejectedValueOnce(
      new Error('disconnect down'),
    );

    await expect(
      service.detachSeat('u1', 'conv-1', 'removed', false),
    ).resolves.toBeUndefined();
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('u1', {
      kind: 'removed',
      conversationId: 'conv-1',
      userId: 'u1',
    });
    expect(systemMessage.emit).not.toHaveBeenCalled();
  });

  it('is a no-op returning null for a missing circle', async () => {
    prisma.circle.findUnique.mockResolvedValue(null);
    await expect(service.ensureCircleConversation('gone')).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers from a concurrent conversation create via unique refetch', async () => {
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    prisma.chatConversation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'conv-1' });
    prisma.chatConversation.create.mockRejectedValue({ code: 'P2002' });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.chatMember.findMany.mockResolvedValue([]);

    await expect(service.ensureCircleConversation('circle-1')).resolves.toBe(
      'conv-1',
    );
  });

  describe('reconcileRecent', () => {
    it('re-syncs each recently changed circle and isolates failures', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { circleID: 'c-bad' },
        { circleID: 'c-good' },
      ]);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('conv-good');

      await service.reconcileRecent();

      expect(ensure).toHaveBeenCalledTimes(2);
      expect(ensure).toHaveBeenNthCalledWith(1, 'c-bad');
      expect(ensure).toHaveBeenNthCalledWith(2, 'c-good');
      ensure.mockRestore();
    });

    it('keeps retrying a circle that failed, even after it ages out of the window', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ circleID: 'c-bad' }]);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockRejectedValueOnce(new Error('boom'));
      await service.reconcileRecent();

      // 下一轮窗口里已经没有这个圈子了(变更时间过期),但它必须继续重试 ——
      // 否则被踢的成员会无限期保留座位。
      prisma.$queryRaw.mockResolvedValueOnce([]);
      ensure.mockResolvedValueOnce('conv-bad');
      await service.reconcileRecent();
      expect(ensure).toHaveBeenNthCalledWith(2, 'c-bad');

      // 成功之后就不再重试。
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.reconcileRecent();
      expect(ensure).toHaveBeenCalledTimes(2);
      ensure.mockRestore();
    });

    // 多实例下只让一个实例扫窗口(每分钟一次全表扫 CircleMember.updatedAt,N 个
    // 实例就是 N 倍);但重试队列只在本机内存里,拿不到租约也得处理,否则排在
    // 这台机器上的失败圈子永远轮不到。
    it('leaves the window scan to the lease holder but still retries its own failed circles', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ circleID: 'c-local-fail' }]);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockRejectedValueOnce(new Error('boom'));
      await service.reconcileRecent();

      redis.tryAcquireLease.mockResolvedValue(null);
      prisma.$queryRaw.mockClear();
      ensure.mockResolvedValueOnce('conv');
      await service.reconcileRecent();

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(ensure).toHaveBeenLastCalledWith('c-local-fail');
      expect(ensure).toHaveBeenCalledTimes(2);
      ensure.mockRestore();
    });

    it('releases the lease after reconciling', async () => {
      redis.tryAcquireLease.mockResolvedValue('lease-token');

      await service.reconcileRecent();

      expect(redis.tryAcquireLease).toHaveBeenCalledWith(
        'job-lease:chat_circle_sync',
        expect.any(Number),
      );
      expect(redis.releaseLease).toHaveBeenCalledWith(
        'job-lease:chat_circle_sync',
        'lease-token',
      );
    });

    it('processes every changed circle below the row cap', async () => {
      const many = Array.from({ length: 500 }, (_, i) => ({
        circleID: `c-${i}`,
      }));
      prisma.$queryRaw.mockResolvedValueOnce(many);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockResolvedValue('conv');

      await service.reconcileRecent();
      expect(ensure).toHaveBeenCalledTimes(500);
      ensure.mockRestore();
    });

    it('commits a capped scan cursor only after its circles reconcile', async () => {
      redis.tryAcquireLease.mockResolvedValue('lease-token');
      const since = new Date(Date.now() - 2 * 60_000);
      const rows = Array.from({ length: 10_000 }, (_, i) => ({
        circleID: `c-${i % 3}`,
        updatedAt: new Date(since.getTime() + i + 1),
      }));
      prisma.$queryRaw.mockResolvedValueOnce(rows);
      const ensure = jest
        .spyOn(service, 'ensureCircleConversation')
        .mockImplementation(async () => {
          const checkpoints = redis.setJsonIfVersionMatches.mock.calls.map(
            ([, , , cursor]) => cursor,
          );
          expect(
            checkpoints.every(
              (cursor) =>
                cursor?.updatedAt !== rows[9999].updatedAt.toISOString(),
            ),
          ).toBe(true);
          return 'conv';
        });
      try {
        await service.reconcileRecent();
        expect(redis.setJsonIfVersionMatches).toHaveBeenLastCalledWith(
          'job-cursor:chat_circle_sync',
          'job-lease:chat_circle_sync',
          'lease-token',
          expect.objectContaining({
            updatedAt: rows[9999].updatedAt.toISOString(),
            circleID: 'c-0',
          }),
          24 * 60 * 60,
        );
      } finally {
        ensure.mockRestore();
      }
    });

    it('replays an unreconciled page after restart even when the live window has advanced', async () => {
      let checkpoint: unknown = null;
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.parse('2026-10-06T10:00:00Z'));
      redis.getJsonMany.mockImplementation(async () => [checkpoint]);
      redis.tryAcquireLease.mockResolvedValue('lease-token');
      redis.setJsonIfVersionMatches.mockImplementation(
        async (_key, _leaseKey, _token, value) => {
          checkpoint = value;
          return true;
        },
      );
      const first = new ChatCircleSyncService(
        prisma as never,
        broadcast as never,
        systemMessage as never,
        groupEvents as never,
        redis as never,
      );
      const since = new Date(Date.now() - 120_000);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          circleID: 'unprocessed',
          updatedAt: new Date(since.getTime() + 1000),
        },
      ]);
      await (first as any).scanChangedCircles(since, 'lease-token');
      expect(checkpoint).toEqual({
        windowSince: since.toISOString(),
        updatedAt: since.toISOString(),
        circleID: '',
      });
      clock.mockReturnValue(Date.parse('2026-10-06T10:05:00Z'));
      const restarted = new ChatCircleSyncService(
        prisma as never,
        broadcast as never,
        systemMessage as never,
        groupEvents as never,
        redis as never,
      );
      const ensure = jest
        .spyOn(restarted, 'ensureCircleConversation')
        .mockResolvedValue('conv');
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          circleID: 'unprocessed',
          updatedAt: new Date(since.getTime() + 1000),
        },
      ]);
      try {
        await restarted.reconcileRecent();
        expect(ensure).toHaveBeenCalledWith('unprocessed');
        expect(
          (prisma.$queryRaw.mock.calls[1][0] as any).values,
        ).toContainEqual(since);
        expect(checkpoint).toEqual({ completed: true });
      } finally {
        clock.mockRestore();
        ensure.mockRestore();
      }
    });

    it('keeps the original scan window when the next tick moves since forward', async () => {
      const firstSince = new Date(Date.now() - 2 * 60_000);
      const cursor = {
        windowSince: firstSince.toISOString(),
        updatedAt: new Date(firstSince.getTime() + 30_000).toISOString(),
        circleID: 'c-0',
      };
      const nextSince = new Date(firstSince.getTime() + 60_000);
      redis.getJsonMany.mockResolvedValue([cursor]);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          circleID: 'c-next',
          updatedAt: new Date(firstSince.getTime() + 31_000),
        },
      ]);

      const scan = (
        service as unknown as {
          scanChangedCircles: (
            value: Date,
          ) => Promise<{ circleIds: string[]; nextCursor: unknown }>;
        }
      ).scanChangedCircles;

      await expect(scan.call(service, nextSince)).resolves.toEqual({
        circleIds: ['c-next'],
        nextCursor: null,
      });
      const query = prisma.$queryRaw.mock.calls[0][0] as {
        values?: unknown[];
      };
      expect(query.values).toEqual(
        expect.arrayContaining([
          firstSince,
          new Date(firstSince.getTime() + 30_000),
          'c-0',
        ]),
      );
    });
  });
});

describe('circle sync durable scan progress', () => {
  const retry = {
    findMany: jest.fn(),
    createMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    chatCircleSyncRetry: retry,
  };
  const redis = {
    tryAcquireLease: jest.fn(),
    renewLease: jest.fn(),
    releaseLease: jest.fn(),
    getJsonMany: jest.fn(),
    setJson: jest.fn(),
    setJsonIfVersionMatches: jest.fn(),
  };
  const make = () =>
    new ChatCircleSyncService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      redis as never,
    );
  beforeEach(() => {
    jest.resetAllMocks();
    retry.findMany.mockResolvedValue([]);
    retry.createMany.mockResolvedValue({ count: 1 });
    retry.updateMany.mockResolvedValue({ count: 1 });
    retry.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation((work) => work(prisma));
    redis.tryAcquireLease.mockResolvedValue(undefined);
    redis.renewLease.mockResolvedValue(true);
    redis.getJsonMany.mockResolvedValue([null]);
    redis.setJson.mockResolvedValue(false);
    redis.setJsonIfVersionMatches.mockResolvedValue(true);
  });
  it('starts a fresh window when another replica completes its retained local checkpoint', async () => {
    const start = Date.parse('2026-10-06T10:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    let checkpoint: unknown = null;
    let owner: string | null = null;
    let leaseNumber = 0;
    redis.tryAcquireLease.mockImplementation(async () => {
      if (owner !== null) return null;
      owner = `lease-${++leaseNumber}`;
      return owner;
    });
    redis.releaseLease.mockImplementation(async (_key, token) => {
      if (token === owner) owner = null;
    });
    redis.getJsonMany.mockImplementation(async () => [checkpoint]);
    redis.setJsonIfVersionMatches.mockImplementation(
      async (_key, _leaseKey, token, value) => {
        if (token !== owner) return false;
        checkpoint = value;
        return true;
      },
    );
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      circleID: `old-${String(index).padStart(5, '0')}`,
      updatedAt: new Date(start - 60_000 + index),
    }));
    prisma.$queryRaw.mockImplementation(async (query) => {
      const [since] = query.values;
      const [after, afterId] =
        query.values.length === 4 ? query.values.slice(1, 3) : [];
      return rows
        .filter(
          (row) =>
            row.updatedAt > since &&
            (!after ||
              row.updatedAt > after ||
              (+row.updatedAt === +after && row.circleID > afterId)),
        )
        .slice(0, 10_000);
    });
    const a = make();
    const b = make();
    const ensureA = jest
      .spyOn(a, 'ensureCircleConversation')
      .mockResolvedValue('conv');
    const ensureB = jest
      .spyOn(b, 'ensureCircleConversation')
      .mockResolvedValue('conv');
    try {
      await a.reconcileRecent();
      const aCheckpoint = (a as any).scanCursor;
      expect(aCheckpoint.circleID).toBe(rows[9999].circleID);
      clock.mockReturnValue(start + 60_000);
      await b.reconcileRecent();
      expect(ensureB).toHaveBeenCalledWith(rows[10000].circleID);
      expect(checkpoint).toEqual({ completed: true });
      expect((a as any).scanCursor).toEqual(aCheckpoint);

      const newer = {
        circleID: 'new-change',
        updatedAt: new Date(start + 170_000),
      };
      rows.push(newer);
      clock.mockReturnValue(start + 180_000);
      ensureA.mockClear();
      await a.reconcileRecent();
      expect(ensureA).toHaveBeenCalledTimes(1);
      expect(ensureA).toHaveBeenCalledWith(newer.circleID);
      expect(prisma.$queryRaw.mock.calls[2][0].values).toEqual([
        new Date(start + 60_000),
        10_000,
      ]);
      expect((a as any).scanCursor).toBeNull();
    } finally {
      clock.mockRestore();
      ensureA.mockRestore();
      ensureB.mockRestore();
    }
  });

  it.each(['outage', 'miss', 'legacy null', 'legacy cursor', 'completed'])(
    'handles the actual Redis JSON decoding of %s',
    async (mode) => {
      const local = {
        windowSince: '2026-10-06T09:55:00.000Z',
        updatedAt: '2026-10-06T09:55:10.000Z',
        circleID: 'local',
      };
      const legacy = {
        windowSince: '2026-10-06T09:56:00.000Z',
        updatedAt: '2026-10-06T09:56:10.000Z',
        circleID: 'shared',
      };
      const transport = { mget: jest.fn() };
      if (mode === 'outage')
        transport.mget.mockRejectedValue(new Error('timeout'));
      else
        transport.mget.mockResolvedValue([
          mode === 'miss'
            ? null
            : JSON.stringify(
                mode === 'legacy null'
                  ? null
                  : mode === 'completed'
                    ? { completed: true }
                    : legacy,
              ),
        ]);
      const reader = new RedisService();
      jest
        .spyOn(reader as any, 'getCommandClient')
        .mockResolvedValue(transport);
      jest.spyOn((reader as any).logger, 'warn').mockImplementation();
      const service = new ChatCircleSyncService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        reader,
      );
      (service as any).scanCursor = local;
      const expected =
        mode === 'completed' ? null : mode === 'legacy cursor' ? legacy : local;
      const result = await (service as any).readScanCursor(
        new Date('2026-10-06T10:00:00Z'),
      );
      expect(result).toEqual(expected);
      expect((service as any).scanCursor).toEqual(expected);
      // Once completion is observed, a following outage cannot resurrect local state.
      if (mode === 'completed') {
        transport.mget.mockRejectedValue(new Error('outage after completion'));
        expect(
          await (service as any).readScanCursor(
            new Date('2026-10-06T10:00:00Z'),
          ),
        ).toBeNull();
      }
    },
  );

  it.each([false, true])(
    'retains shared and local state when a fenced %s completion write is rejected',
    async (completion) => {
      const previous = {
        windowSince: '2026-10-06T09:55:00.000Z',
        updatedAt: '2026-10-06T09:55:10.000Z',
        circleID: 'previous',
      };
      const next = completion
        ? null
        : {
            ...previous,
            circleID: 'next',
            updatedAt: '2026-10-06T09:55:20.000Z',
          };
      let checkpoint: unknown = previous;
      redis.setJsonIfVersionMatches.mockImplementation(
        async (_key, _lease, token, value) => {
          if (token !== 'current') return false;
          checkpoint = value;
          return true;
        },
      );
      const service = make();
      (service as any).scanCursor = previous;
      expect(await (service as any).writeScanCursor(next, 'expired')).toBe(
        false,
      );
      expect(checkpoint).toEqual(previous);
      expect((service as any).scanCursor).toEqual(previous);
      expect(redis.setJsonIfVersionMatches).toHaveBeenCalledWith(
        'job-cursor:chat_circle_sync',
        'job-lease:chat_circle_sync',
        'expired',
        completion ? { completed: true } : next,
        expect.any(Number),
      );
      expect(redis.setJson).not.toHaveBeenCalled();
    },
  );
  it('renews a scan lasting beyond 50 seconds and continues with its next page', async () => {
    jest.useFakeTimers();
    const start = Date.parse('2026-10-06T10:00:00Z');
    jest.setSystemTime(start);
    let checkpoint: unknown = null;
    redis.tryAcquireLease.mockResolvedValue('owner');
    redis.getJsonMany.mockImplementation(async () => [checkpoint]);
    redis.setJsonIfVersionMatches.mockImplementation(
      async (_key, _leaseKey, _owner, value) => {
        checkpoint = value;
        return true;
      },
    );
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      circleID: `c-${i}`,
      updatedAt: new Date(start - 60_000 + i),
    }));
    prisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([
        { circleID: 'second-page', updatedAt: new Date(start - 40_000) },
      ]);
    let finish!: () => void;
    let notifyStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const service = make();
    const ensure = jest
      .spyOn(service, 'ensureCircleConversation')
      .mockImplementation(async (id) => {
        if (id === 'c-0') {
          notifyStarted();
          await held;
        }
        return 'conv';
      });
    const round = service.reconcileRecent();
    try {
      await started;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(redis.renewLease).toHaveBeenCalledWith(
        'job-lease:chat_circle_sync',
        'owner',
        50_000,
      );
      finish();
      await round;
      expect(checkpoint).toEqual(
        expect.objectContaining({ circleID: 'c-9999' }),
      );
      await service.reconcileRecent();
      expect(ensure).toHaveBeenCalledWith('second-page');
      expect(prisma.$queryRaw.mock.calls[1][0].values).toContain('c-9999');
      expect(checkpoint).toEqual({ completed: true });
    } finally {
      finish();
      await round;
      jest.useRealTimers();
    }
  });

  it('stops subsequent circle work and keeps the replay window after renewal loses ownership', async () => {
    jest.useFakeTimers();
    redis.tryAcquireLease.mockResolvedValue('owner');
    redis.renewLease.mockResolvedValue(false);
    prisma.$queryRaw.mockResolvedValue([
      { circleID: 'first', updatedAt: new Date(Date.now() - 30_000) },
      { circleID: 'second', updatedAt: new Date(Date.now() - 20_000) },
    ]);
    let finish!: () => void;
    let notifyStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const service = make();
    const ensure = jest
      .spyOn(service, 'ensureCircleConversation')
      .mockImplementation(async () => {
        notifyStarted();
        await held;
        return 'conv';
      });
    const round = service.reconcileRecent();
    try {
      await started;
      await jest.advanceTimersByTimeAsync(17_000);
      finish();
      await round;
      expect(ensure).toHaveBeenCalledTimes(1);
      expect(retry.deleteMany).not.toHaveBeenCalled();
      expect(redis.setJsonIfVersionMatches).toHaveBeenCalledTimes(1);
      expect((service as any).scanCursor.circleID).toBe('');
    } finally {
      finish();
      await round;
      jest.useRealTimers();
    }
  });
  it('retains the local window and reaches the second page after Redis recovers without a key', async () => {
    const start = Date.parse('2026-10-06T10:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      circleID: `c-${i}`,
      updatedAt: new Date(start - 60_000 + i),
    }));
    prisma.$queryRaw
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([
        { circleID: 'after-cap', updatedAt: new Date(start - 40_000) },
      ]);
    const service = make();
    const ensure = jest
      .spyOn(service, 'ensureCircleConversation')
      .mockImplementation(async (id) => {
        if (id === 'c-0') throw new Error('permanent failure');
        return 'conv';
      });
    try {
      await service.reconcileRecent();
      expect(retry.createMany).toHaveBeenCalledWith({
        data: [{ circleID: 'c-0' }],
        skipDuplicates: true,
      });
      expect(redis.setJson).not.toHaveBeenCalled();
      expect(redis.setJsonIfVersionMatches).not.toHaveBeenCalled();
      clock.mockReturnValue(start + 300_000);
      redis.tryAcquireLease.mockResolvedValue('recovered-lease');
      await service.reconcileRecent();
      expect(ensure).toHaveBeenCalledWith('after-cap');
      const values = prisma.$queryRaw.mock.calls[1][0].values;
      expect(values).toContainEqual(new Date(start - 120_000));
      expect(values).toContainEqual(rows[9999].updatedAt);
      expect(values).toContain('c-9999');
    } finally {
      clock.mockRestore();
    }
  });
  it('retries persisted failures on another service instance', async () => {
    retry.findMany.mockResolvedValue([{ circleID: 'persisted-failure' }]);
    prisma.$queryRaw.mockResolvedValue([]);
    const restarted = make();
    const ensure = jest
      .spyOn(restarted, 'ensureCircleConversation')
      .mockResolvedValue('conv');
    await restarted.reconcileRecent();
    expect(ensure).toHaveBeenCalledWith('persisted-failure');
    expect(retry.deleteMany).toHaveBeenCalledWith({
      where: {
        circleID: { in: ['persisted-failure'] },
        nextAttemptAt: { lte: expect.any(Date) },
      },
    });
  });
  it('does not advance the page if failed IDs cannot be durably checkpointed', async () => {
    redis.tryAcquireLease.mockResolvedValue('lease-token');
    prisma.$queryRaw.mockResolvedValue(
      Array.from({ length: 10_000 }, (_, i) => ({
        circleID: 'failed',
        updatedAt: new Date(Date.now() - 30_000 + i),
      })),
    );
    retry.createMany.mockRejectedValue(new Error('database unavailable'));
    const service = make();
    jest
      .spyOn(service, 'ensureCircleConversation')
      .mockRejectedValue(new Error('failed'));
    await service.reconcileRecent();
    expect(redis.setJsonIfVersionMatches).toHaveBeenCalledTimes(1);
    expect(redis.setJsonIfVersionMatches.mock.calls[0][3].circleID).toBe('');
  });

  it('stops before scanning when its initial checkpoint loses the lease', async () => {
    redis.tryAcquireLease.mockResolvedValue('expired-lease');
    redis.setJsonIfVersionMatches.mockResolvedValue(false);
    const service = make();

    await service.reconcileRecent();

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(retry.findMany).not.toHaveBeenCalled();
    expect((service as any).scanCursor).toBeNull();
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('keeps a newer durable failure when an older attempt finishes successfully', async () => {
    jest.useFakeTimers();
    const start = Date.parse('2026-10-06T10:00:00Z');
    jest.setSystemTime(start);
    const pending = new Map<string, Date>();
    retry.findMany.mockImplementation(async ({ where }) =>
      [...pending]
        .filter(([, due]) => due <= where.nextAttemptAt.lte)
        .map(([circleID]) => ({ circleID })),
    );
    retry.createMany.mockImplementation(async ({ data }) => {
      for (const { circleID } of data) {
        if (!pending.has(circleID)) pending.set(circleID, new Date());
      }
      return { count: data.length };
    });
    retry.updateMany.mockImplementation(async ({ where, data }) => {
      for (const circleID of where.circleID.in)
        pending.set(circleID, data.nextAttemptAt);
      return { count: where.circleID.in.length };
    });
    retry.deleteMany.mockImplementation(async ({ where }) => {
      for (const circleID of where.circleID.in) {
        const due = pending.get(circleID);
        if (due && (!where.nextAttemptAt || due <= where.nextAttemptAt.lte))
          pending.delete(circleID);
      }
      return { count: 1 };
    });
    let finishOlder!: () => void;
    let olderStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      finishOlder = resolve;
    });
    const started = new Promise<void>((resolve) => {
      olderStarted = resolve;
    });
    const older = make();
    jest
      .spyOn(older, 'ensureCircleConversation')
      .mockImplementation(async () => {
        olderStarted();
        await held;
        return 'conv';
      });
    const newer = make();
    jest
      .spyOn(newer, 'ensureCircleConversation')
      .mockRejectedValue(new Error('newer membership failed'));
    let olderRun: Promise<void> | undefined;
    try {
      olderRun = (older as any).reconcileCircles(['changed-circle'], true);
      await started;
      jest.setSystemTime(start + 60_000);
      await (newer as any).reconcileCircles(['changed-circle'], true);
      const newerDue = new Date(start + 120_000);
      expect(pending.get('changed-circle')).toEqual(newerDue);

      jest.setSystemTime(start + 260_000);
      finishOlder();
      await olderRun;
      expect(pending.get('changed-circle')).toEqual(newerDue);

      const restarted = make();
      const ensure = jest
        .spyOn(restarted, 'ensureCircleConversation')
        .mockResolvedValue('conv');
      await (restarted as any).reconcileCircles([], true);
      expect(ensure).toHaveBeenCalledWith('changed-circle');
      expect(pending.size).toBe(0);
    } finally {
      finishOlder();
      await olderRun;
      jest.useRealTimers();
    }
  });

  it('rejects an expired run clearing a newer recovery window and replays it after restart', async () => {
    const start = Date.parse('2026-10-06T10:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    let checkpoint: unknown = null;
    let lease: { owner: string; expires: number } | null = null;
    let tokenNumber = 0;
    const rows = [
      { circleID: 'old-circle', updatedAt: new Date(start - 30_000) },
    ];
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const holdA = deferred();
    const startedA = deferred();
    const holdC = deferred();
    const startedC = deferred();
    redis.tryAcquireLease.mockImplementation(async (_key, ttl) => {
      if (lease && lease.expires > Date.now()) return null;
      lease = { owner: String(++tokenNumber), expires: Date.now() + ttl };
      return lease.owner;
    });
    redis.releaseLease.mockImplementation(async (_key, owner) => {
      if (lease?.owner === owner) lease = null;
    });
    redis.getJsonMany.mockImplementation(async () => [checkpoint]);
    redis.setJsonIfVersionMatches.mockImplementation(
      async (_key, _leaseKey, owner, value) => {
        if (lease?.owner !== owner || lease.expires <= Date.now()) return false;
        checkpoint = value;
        return true;
      },
    );
    prisma.$queryRaw.mockImplementation(async (query) => {
      const [since, after, afterId] = query.values;
      return rows.filter(
        (row) =>
          row.updatedAt > since &&
          (!after ||
            row.updatedAt > after ||
            (+row.updatedAt === +after && row.circleID > afterId)),
      );
    });
    const a = make();
    jest.spyOn(a, 'ensureCircleConversation').mockImplementation(async () => {
      startedA.resolve();
      await holdA.promise;
      return 'conv';
    });
    const b = make();
    jest.spyOn(b, 'ensureCircleConversation').mockResolvedValue('conv');
    const c = make();
    jest.spyOn(c, 'ensureCircleConversation').mockImplementation(async () => {
      startedC.resolve();
      await holdC.promise;
      return 'conv';
    });
    let pendingA: Promise<void> | undefined;
    let pendingC: Promise<void> | undefined;
    try {
      pendingA = a.reconcileRecent();
      await startedA.promise;
      const initialA = checkpoint;
      clock.mockReturnValue(start + 60_000);
      await b.reconcileRecent();
      expect(checkpoint).toEqual({ completed: true });

      rows.push({
        circleID: 'new-circle',
        updatedAt: new Date(start + 90_000),
      });
      clock.mockReturnValue(start + 120_000);
      pendingC = c.reconcileRecent();
      await startedC.promise;
      const recoveryWindow = checkpoint;

      clock.mockReturnValue(start + 260_000);
      holdA.resolve();
      await pendingA;
      expect(checkpoint).toEqual(recoveryWindow);
      expect((a as any).scanCursor).toEqual(initialA);

      // C stops before reconciliation/checkpointing; a fresh instance must
      // still replay the saved window although the changed row has aged out.
      clock.mockReturnValue(start + 300_000);
      const restarted = make();
      const ensure = jest
        .spyOn(restarted, 'ensureCircleConversation')
        .mockResolvedValue('conv');
      await restarted.reconcileRecent();
      expect(ensure).toHaveBeenCalledWith('new-circle');
      expect(checkpoint).toEqual({ completed: true });
      expect(redis.setJson).not.toHaveBeenCalled();
    } finally {
      holdA.resolve();
      holdC.resolve();
      await Promise.all([pendingA, pendingC]);
      clock.mockRestore();
    }
  });
});
