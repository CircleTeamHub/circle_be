import { ChatPushService } from './chat-push.service';
import type { ChatMessageDto } from './chat.types';

function msg(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    height: 5,
    type: 'text',
    content: { text: 'hello world' },
    sender: { id: 'u-sender', nickname: '发送者', avatarUrl: null },
    replyToId: null,
    d: 'd1',
    createdAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

describe('ChatPushService', () => {
  const prisma = {
    chatMember: { findMany: jest.fn() },
    chatConversation: { findUnique: jest.fn() },
    circle: { findUnique: jest.fn() },
  };
  const push = {
    listActiveTokens: jest.fn(),
    sendToTokens: jest.fn(),
  };
  const broadcast = { getOnlineUserIdsInConversation: jest.fn() };

  const service = new ChatPushService(
    prisma as never,
    push as never,
    broadcast as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'DIRECT',
      circleID: null,
    });
    broadcast.getOnlineUserIdsInConversation.mockResolvedValue(new Set());
    push.listActiveTokens.mockResolvedValue([
      { token: 'ExponentPushToken[a]', projectId: null },
    ]);
    push.sendToTokens.mockResolvedValue([]);
  });

  it('pushes to offline unmuted members and excludes the sender in the query', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u-peer', muted: false },
    ]);

    await service.onMessageBroadcast(msg());

    expect(prisma.chatMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userID: { not: 'u-sender' } }),
      }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledWith('u-peer');
    expect(push.sendToTokens).toHaveBeenCalledWith(
      [{ token: 'ExponentPushToken[a]', projectId: null }],
      expect.objectContaining({
        title: '发送者',
        body: 'hello world',
        data: expect.objectContaining({
          type: 'chat',
          conversationId: 'conv-1',
          sourceID: 'u-sender',
          conversationType: 'private',
        }),
      }),
    );
  });

  it('skips members that are online in the conversation room', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u-online', muted: false },
      { userID: 'u-offline', muted: false },
    ]);
    broadcast.getOnlineUserIdsInConversation.mockResolvedValue(
      new Set(['u-online']),
    );

    await service.onMessageBroadcast(msg());

    expect(push.listActiveTokens).toHaveBeenCalledTimes(1);
    expect(push.listActiveTokens).toHaveBeenCalledWith('u-offline');
  });

  it('respects mute but lets mentions and atAll pierce it', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u-muted', muted: true },
      { userID: 'u-muted-mentioned', muted: true },
    ]);

    await service.onMessageBroadcast(
      msg({
        content: { text: 'hi', mentions: [{ userId: 'u-muted-mentioned' }] },
      }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(1);
    expect(push.listActiveTokens).toHaveBeenCalledWith('u-muted-mentioned');

    push.listActiveTokens.mockClear();
    await service.onMessageBroadcast(
      msg({ content: { text: 'all hands', atAll: true } }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(2);
  });

  it('titles group pushes with the circle name and prefixes the sender', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u-peer', muted: false },
    ]);
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'GROUP',
      circleID: 'circle-1',
    });
    prisma.circle.findUnique.mockResolvedValue({ name: '登山圈' });

    await service.onMessageBroadcast(
      msg({ type: 'image', content: { key: 'k' } }),
    );

    expect(push.sendToTokens).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: '登山圈',
        body: '发送者: [图片]',
        data: expect.objectContaining({
          sourceID: 'circle-1',
          conversationType: 'group',
        }),
      }),
    );
  });

  it('never throws upward even when the pipeline fails', async () => {
    prisma.chatMember.findMany.mockRejectedValue(new Error('db down'));
    await expect(service.onMessageBroadcast(msg())).resolves.toBeUndefined();
    expect(push.sendToTokens).not.toHaveBeenCalled();
  });

  it('skips members without any active token', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u-peer', muted: false },
    ]);
    push.listActiveTokens.mockResolvedValue([]);
    await service.onMessageBroadcast(msg());
    expect(push.sendToTokens).not.toHaveBeenCalled();
  });
});
