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
    $queryRaw: jest.fn().mockResolvedValue([]),
    chatMember: { findMany: jest.fn() },
    chatConversation: { findUnique: jest.fn() },
    circle: { findUnique: jest.fn() },
    tempChat: { findUnique: jest.fn() },
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

  it('attaches a per-recipient unread badge on small fanouts (G-18)', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'u-peer', muted: false },
    ]);
    // BigInt() 而非 7n 字面量:tsconfig target 是 es2017,字面量过不了 tsc。
    prisma.$queryRaw.mockResolvedValue([
      { userID: 'u-peer', count: BigInt(7) },
    ]);

    await service.onMessageBroadcast(msg());

    expect(push.sendToTokens).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ badge: 7 }),
    );
  });

  it('fetches every seat in one bounded query instead of paging (G-06)', async () => {
    // 3000 人群从 6 次游标往返降到 1 次;上限 6000 只是失控兜底(触顶打 warn)。
    const seats = Array.from({ length: 1120 }, (_, i) => ({
      userID: `u${i}`,
      muted: false,
    }));
    prisma.chatMember.findMany.mockResolvedValue(seats);

    await service.onMessageBroadcast(msg());

    expect(prisma.chatMember.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 6000 }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(1120);
  });

  it('pushes to offline unmuted members and excludes the sender in the query', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { id: 's1', userID: 'u-peer', muted: false },
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
      { id: 's3', userID: 'u-online', muted: false },
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
      { id: 's2', userID: 'u-muted', muted: true },
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
      { id: 's1', userID: 'u-peer', muted: false },
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

  it('routes TEMP pushes back into the temporary group conversation', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { id: 's1', userID: 'u-host', muted: false },
    ]);
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'TEMP',
      circleID: null,
      tempChatID: 'tc-1',
    });
    prisma.tempChat.findUnique.mockResolvedValue({ title: '周末临时群' });

    await service.onMessageBroadcast(msg());

    expect(push.sendToTokens).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: '周末临时群',
        body: '发送者: hello world',
        data: expect.objectContaining({
          conversationId: 'conv-1',
          sourceID: 'conv-1',
          conversationType: 'group',
          conversationKind: 'temp',
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
      { id: 's1', userID: 'u-peer', muted: false },
    ]);
    push.listActiveTokens.mockResolvedValue([]);
    await service.onMessageBroadcast(msg());
    expect(push.sendToTokens).not.toHaveBeenCalled();
  });

  // allSettled 会把每个收件人的失败原样吞掉:不看返回值的话,供应商或数据库
  // 整体故障时 dispatch 照样"成功"返回,外层失败日志一次都不触发 —— 整场扇出
  // 静默蒸发,运维侧没有任何信号。
  it('logs a bounded summary when every recipient fails', async () => {
    prisma.chatMember.findMany.mockResolvedValueOnce([
      { id: 's1', userID: 'u2', muted: false },
      { id: 's2', userID: 'u3', muted: false },
    ]);
    push.listActiveTokens.mockRejectedValue(new Error('provider down'));
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (service as any).logger = logger;

    await service.onMessageBroadcast(msg());

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('2/2 recipients failed'),
    );
    // 3000 人的群失败不能刷 3000 行:只汇总一条。
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
