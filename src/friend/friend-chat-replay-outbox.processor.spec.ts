import { FriendChatReplayOutboxProcessor } from './friend-chat-replay-outbox.processor';

describe('FriendChatReplayOutboxProcessor', () => {
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
    const openim = {
      importFriends: jest.fn().mockResolvedValue(undefined),
      sendTextMessage: jest.fn().mockResolvedValue(undefined),
    };

    const processor = new FriendChatReplayOutboxProcessor(
      prisma as any,
      openim as any,
    );

    await processor.processPending();

    expect(openim.importFriends).toHaveBeenCalledWith('user-1', ['user-2']);
    expect(openim.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sendID: 'user-1',
        recvID: 'user-2',
        content: 'hello',
        notOfflinePush: true,
        clientMsgID: 'friend-request:request-1:message-1',
      }),
    );
  });
});
