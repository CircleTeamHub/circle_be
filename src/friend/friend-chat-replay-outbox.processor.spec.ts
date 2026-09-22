import { FriendChatReplayOutboxProcessor } from './friend-chat-replay-outbox.processor';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { createWinstonOptions } from '../logging/winston-options';

describe('FriendChatReplayOutboxProcessor', () => {
  it('keeps replay identity but not exception prose in actual production JSON', async () => {
    const options = createWinstonOptions(
      {
        get: (key) =>
          key === 'LOG_ON' ? true : key === 'LOG_FILE_ON' ? false : undefined,
      },
      'production',
    );
    const sink = options
      .transports[0] as winston.transports.ConsoleTransportInstance;
    const lines: string[] = [];
    const spy = jest.spyOn(sink, 'log').mockImplementation((info, callback) => {
      lines.push(info[Symbol.for('message')]);
      callback?.();
    });
    const logger = winston.createLogger(options);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const processor = new FriendChatReplayOutboxProcessor(
      {
        friendChatReplayOutbox: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'job-safe',
              requestId: 'friend-request-safe',
              requesterUserID: 'u1',
              accepterUserID: 'u2',
              status: 'PENDING',
              stage: 2,
              attempts: 0,
            },
          ]),
          updateMany,
        },
        friend: {
          findUnique: jest
            .fn()
            .mockRejectedValue(new Error('arbitrary PRIVATE_CHAT_BODY')),
        },
        friendRequestMessage: { findMany: jest.fn().mockResolvedValue([]) },
        user: { findUnique: jest.fn().mockResolvedValue(null) },
      } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (processor as any).logger = WinstonModule.createLogger({
      instance: logger,
    });
    try {
      await processor.processPending();
      expect(lines.join('')).not.toContain('PRIVATE_CHAT_BODY');
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          event: 'friend_chat_replay_failed',
          outboxId: 'job-safe',
          level: 'warn',
        }),
      );
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            lastError: 'arbitrary PRIVATE_CHAT_BODY',
          }),
        }),
      );
    } finally {
      logger.close();
      spy.mockRestore();
    }
  });
  it('replays a pending thread without offline push and advances progress', async () => {
    const prisma = {
      friendChatReplayOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'job-1',
            requestId: 'request-1',
            requesterUserID: 'user-1',
            accepterUserID: 'user-2',
            status: 'PENDING',
            stage: 0,
            messageIndex: 0,
            attempts: 0,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      friendRequestMessage: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'message-1', senderId: 'user-1', content: 'hello' },
          ]),
      },
      friend: {
        findUnique: jest.fn().mockResolvedValue({ message: 'hello' }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          nickname: 'Alice',
          accountId: 'alice',
          avatarUrl: null,
        }),
      },
    };
    const chatService = {
      // 回放走结算专用解析(不过拉黑/陌生人闸):申请已被接受,这些是既成事实的补投。
      ensureDirectConversationForSettlement: jest
        .fn()
        .mockResolvedValue('conv-1'),
    };
    const chatMessages = {
      insertServerMessage: jest.fn().mockResolvedValue(undefined),
    };

    const sensitiveWords = {
      check: jest.fn().mockReturnValue({ blocked: false }),
    };
    const processor = new FriendChatReplayOutboxProcessor(
      prisma as any,
      chatService as any,
      chatMessages as any,
      sensitiveWords as any,
    );

    await processor.processPending();

    // 申请期消息以原发送者身份回放进双方 1:1 会话
    expect(chatMessages.insertServerMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        senderID: 'user-1',
        type: 'text',
        content: { text: 'hello' },
        clientMessageId: 'friend-request:request-1:message-1',
      }),
    );
    // 接受方的固定答复也补进会话（stage 3）
    expect(chatMessages.insertServerMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        senderID: 'user-2',
        clientMessageId: 'friend-request:request-1:accepted',
      }),
    );
    // 回放是补历史，任何一条都不触发离线推送
    const pushed = chatMessages.insertServerMessage.mock.calls.some(
      ([, options]: [string, { push?: boolean }]) => options.push,
    );
    expect(pushed).toBe(false);
    const writes = prisma.friendChatReplayOutbox.updateMany.mock.calls.map(
      ([input]) => input,
    );
    const leaseToken = writes[0].data.leaseToken;
    expect(leaseToken).toEqual(expect.any(String));
    expect(writes.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'job-1',
            leaseToken,
            status: 'PROCESSING',
          }),
        }),
      ]),
    );
    expect(prisma.friendChatReplayOutbox.update).not.toHaveBeenCalled();
  });

  it('claims stale processing work using the observed lock and a new lease', async () => {
    const observedLock = new Date('2026-07-11T00:00:00.000Z');
    const prisma = {
      friendChatReplayOutbox: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'job-stale',
            requestId: 'request-1',
            requesterUserID: 'user-1',
            accepterUserID: 'user-2',
            status: 'PROCESSING',
            lockedAt: observedLock,
            stage: 4,
            messageIndex: 0,
            attempts: 1,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      friendRequestMessage: { findMany: jest.fn() },
      friend: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    const processor = new FriendChatReplayOutboxProcessor(
      prisma as any,
      { ensureDirectConversationForSettlement: jest.fn() } as any,
      { insertServerMessage: jest.fn() } as any,
      { check: jest.fn().mockReturnValue({ blocked: false }) } as any,
    );

    await processor.processPending();

    const claim = prisma.friendChatReplayOutbox.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({
      id: 'job-stale',
      status: 'PROCESSING',
      lockedAt: observedLock,
    });
    expect(claim.data.leaseToken).toEqual(expect.any(String));
  });
});
