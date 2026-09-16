import { CHAT_PUSH_COALESCE_MS, ChatPushService } from './chat-push.service';
import type { ChatMessageDto } from './chat.types';

function msg(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    height: 5,
    type: 'text',
    content: { text: 'hello world' },
    sender: {
      id: 'u-sender',
      nickname: '发送者',
      avatarUrl: null,
      alias: null,
    },
    replyToId: null,
    d: 'd1',
    createdAt: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

function seat(
  userID: string,
  overrides: Partial<{
    muted: boolean;
    lastReadHeight: number;
    clearedBeforeHeight: number;
  }> = {},
) {
  return {
    userID,
    muted: false,
    lastReadHeight: 0,
    clearedBeforeHeight: 0,
    ...overrides,
  };
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

describe('ChatPushService', () => {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    chatMember: { findMany: jest.fn() },
    chatMessage: { findMany: jest.fn() },
    chatConversation: { findUnique: jest.fn() },
    circle: { findUnique: jest.fn() },
    tempChat: { findUnique: jest.fn() },
  };
  const push = {
    listActiveTokens: jest.fn(),
    sendToTokens: jest.fn(),
  };
  const broadcast = { getDeliverableUserIdsInConversation: jest.fn() };

  let service: ChatPushService;

  /** 入窗后立刻结束窗口并等推送落定(合并行为另有用例单测)。 */
  async function pushNow(message: ChatMessageDto): Promise<void> {
    await service.onMessageBroadcast(message);
    await service.flushPending();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ChatPushService(
      prisma as never,
      push as never,
      broadcast as never,
    );
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'DIRECT',
      circleID: null,
    });
    // 默认:窗口里的消息都还在、都没撤回。
    prisma.chatMessage.findMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({ id, revokedAt: null, deleted: false })),
        ),
    );
    broadcast.getDeliverableUserIdsInConversation.mockResolvedValue(new Set());
    push.listActiveTokens.mockResolvedValue([
      { token: 'ExponentPushToken[a]', projectId: null },
    ]);
    push.sendToTokens.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('attaches a per-recipient unread badge on small fanouts (G-18)', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);
    // BigInt() 而非 7n 字面量:tsconfig target 是 es2017,字面量过不了 tsc。
    prisma.$queryRaw.mockResolvedValue([
      { userID: 'u-peer', count: BigInt(7) },
    ]);

    await pushNow(msg());

    expect(push.sendToTokens).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ badge: 7 }),
    );
  });

  it('counts neither recalled messages nor muted conversations in the badge', async () => {
    // app 角标(selectTotalUnread)不算免打扰会话;撤回的消息服务端未读也不算。
    // 推送角标另算一套的话,每来一条推送 iOS 图标上的数字就和 app 里对不上。
    prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

    await pushNow(msg());

    const badgeQuery = prisma.$queryRaw.mock.calls.map(sqlText).join('\n');
    expect(badgeQuery).toContain('m."revokedAt" IS NULL');
    expect(badgeQuery).toContain('cm."muted" = false');
  });

  it('fetches every seat in one bounded query instead of paging (G-06)', async () => {
    // 3000 人群从 6 次游标往返降到 1 次;上限 6000 只是失控兜底(触顶打 warn)。
    const seats = Array.from({ length: 1120 }, (_, i) => seat(`u${i}`));
    prisma.chatMember.findMany.mockResolvedValue(seats);

    await pushNow(msg());

    expect(prisma.chatMember.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 6000 }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(1120);
  });

  it('pushes to members who have neither read nor cleared past the message, never to the sender', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      seat('u-peer'),
      seat('u-sender'),
    ]);

    await pushNow(msg());

    expect(prisma.chatMember.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          conversationID: 'conv-1',
          leftAt: null,
          clearedBeforeHeight: { lt: 5 },
        },
        // 只取 ChatMember_fanout_idx 覆盖的列(见 fanout index migration spec)。
        select: { userID: true, muted: true },
      }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(1);
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

  it('skips members with a foreground connection but still pushes to backgrounded ones', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      seat('u-watching'),
      seat('u-locked-screen'),
    ]);
    // 注册表只把前台连接算「收得到」:锁屏那台手机不在集合里。
    broadcast.getDeliverableUserIdsInConversation.mockResolvedValue(
      new Set(['u-watching']),
    );

    await pushNow(msg());

    expect(push.listActiveTokens).toHaveBeenCalledTimes(1);
    expect(push.listActiveTokens).toHaveBeenCalledWith('u-locked-screen');
  });

  it('respects mute but lets mentions and atAll pierce it', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      seat('u-muted', { muted: true }),
      seat('u-muted-mentioned', { muted: true }),
    ]);

    await pushNow(
      msg({
        content: { text: 'hi', mentions: [{ userId: 'u-muted-mentioned' }] },
      }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(1);
    expect(push.listActiveTokens).toHaveBeenCalledWith('u-muted-mentioned');

    push.listActiveTokens.mockClear();
    await pushNow(
      msg({ id: 'msg-2', content: { text: 'all hands', atAll: true } }),
    );
    expect(push.listActiveTokens).toHaveBeenCalledTimes(2);
  });

  describe('coalescing', () => {
    it('turns a burst in one conversation into a single push of the newest message', async () => {
      jest.useFakeTimers();
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await service.onMessageBroadcast(msg({ id: 'm5', height: 5 }));
      await service.onMessageBroadcast(
        msg({ id: 'm6', height: 6, content: { text: 'second' } }),
      );
      await service.onMessageBroadcast(
        msg({ id: 'm7', height: 7, content: { text: 'third' } }),
      );
      jest.advanceTimersByTime(CHAT_PUSH_COALESCE_MS - 1);
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await service.flushPending();

      expect(push.sendToTokens).toHaveBeenCalledTimes(1);
      expect(push.sendToTokens).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: 'third' }),
      );
    });

    it('does not slide the window, so a busy chat still pushes about once a window', async () => {
      jest.useFakeTimers();
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await service.onMessageBroadcast(msg({ id: 'm5', height: 5 }));
      jest.advanceTimersByTime(CHAT_PUSH_COALESCE_MS - 100);
      await service.onMessageBroadcast(msg({ id: 'm6', height: 6 }));
      jest.advanceTimersByTime(100);
      await service.flushPending();
      expect(push.sendToTokens).toHaveBeenCalledTimes(1);

      await service.onMessageBroadcast(msg({ id: 'm7', height: 7 }));
      await service.flushPending();
      expect(push.sendToTokens).toHaveBeenCalledTimes(2);
    });

    it('keeps separate windows per conversation', async () => {
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await service.onMessageBroadcast(
        msg({ id: 'a', conversationId: 'conv-a' }),
      );
      await service.onMessageBroadcast(
        msg({ id: 'b', conversationId: 'conv-b' }),
      );
      await service.flushPending();

      expect(push.sendToTokens).toHaveBeenCalledTimes(2);
    });

    it('still tells a muted member they were mentioned earlier in the window', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        seat('u-muted', { muted: true }),
      ]);

      await service.onMessageBroadcast(
        msg({
          id: 'm5',
          height: 5,
          content: { text: '@你 看一下', mentions: [{ userId: 'u-muted' }] },
        }),
      );
      await service.onMessageBroadcast(
        msg({ id: 'm6', height: 6, content: { text: '好的' } }),
      );
      await service.flushPending();

      // 预览必须是点名他的那条:被后面一句「好的」盖掉,等于没通知。
      expect(push.sendToTokens).toHaveBeenCalledTimes(1);
      expect(push.sendToTokens).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: '@你 看一下' }),
      );
    });

    it('skips members who read or cleared the message elsewhere before the window closed', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        seat('u-read-on-desktop', { lastReadHeight: 5 }),
        seat('u-cleared', { clearedBeforeHeight: 5 }),
        seat('u-behind', { lastReadHeight: 4 }),
      ]);

      await pushNow(msg({ height: 5 }));

      expect(push.listActiveTokens).toHaveBeenCalledTimes(1);
      expect(push.listActiveTokens).toHaveBeenCalledWith('u-behind');
    });

    it('never pushes the content of a message recalled before the window closed', async () => {
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);
      prisma.chatMessage.findMany.mockResolvedValue([
        { id: 'msg-1', revokedAt: new Date(), deleted: false },
      ]);

      await pushNow(msg());

      expect(push.sendToTokens).not.toHaveBeenCalled();
    });

    it('flushes pending windows on shutdown', async () => {
      jest.useFakeTimers();
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await service.onMessageBroadcast(msg());
      await service.onModuleDestroy();

      expect(push.sendToTokens).toHaveBeenCalledTimes(1);
    });
  });

  it('titles group pushes with the circle name and prefixes the sender', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'GROUP',
      circleID: 'circle-1',
    });
    prisma.circle.findUnique.mockResolvedValue({ name: '登山圈' });

    await pushNow(msg({ type: 'image', content: { key: 'k' } }));

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
    prisma.chatMember.findMany.mockResolvedValue([seat('u-host')]);
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'TEMP',
      circleID: null,
      tempChatID: 'tc-1',
    });
    prisma.tempChat.findUnique.mockResolvedValue({ title: '周末临时群' });

    await pushNow(msg());

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
    await expect(pushNow(msg())).resolves.toBeUndefined();
    expect(push.sendToTokens).not.toHaveBeenCalled();
  });

  it('skips members without any active token', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);
    push.listActiveTokens.mockResolvedValue([]);
    await pushNow(msg());
    expect(push.sendToTokens).not.toHaveBeenCalled();
  });

  // allSettled 会把每个收件人的失败原样吞掉:不看返回值的话,供应商或数据库
  // 整体故障时 dispatch 照样"成功"返回,外层失败日志一次都不触发 —— 整场扇出
  // 静默蒸发,运维侧没有任何信号。
  it('logs a bounded summary when every recipient fails', async () => {
    prisma.chatMember.findMany.mockResolvedValueOnce([seat('u2'), seat('u3')]);
    push.listActiveTokens.mockRejectedValue(new Error('provider down'));
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (service as unknown as { logger: typeof logger }).logger = logger;

    await pushNow(msg());

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('2/2 recipients failed'),
    );
    // 3000 人的群失败不能刷 3000 行:只汇总一条。
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
