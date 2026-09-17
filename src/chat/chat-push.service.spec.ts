import { CHAT_PUSH_COALESCE_MS, ChatPushService } from './chat-push.service';
import type { ChatMessageDto } from './chat.types';

function msg(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    height: 5,
    revision: 5,
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
  // 一次查回全部收件人的 token、按 100 条一批发给 Expo(见 sendToRecipients)。
  const push = {
    listActiveTokensForUsers: jest.fn(),
    sendMessages: jest.fn(),
  };
  /** 这次扇出实际去查了 token 的收件人。 */
  const pushedUserIds = (): string[] =>
    push.listActiveTokensForUsers.mock.calls.flatMap(
      ([userIds]: [string[]]) => userIds,
    );
  /** 发给 Expo 的每一条消息的载荷。 */
  const sentPayloads = (): Array<Record<string, unknown>> =>
    push.sendMessages.mock.calls.flatMap(
      ([messages]: [Array<{ payload: Record<string, unknown> }>]) =>
        messages.map((message) => message.payload),
    );
  const broadcast = { getForegroundPushTokensInConversation: jest.fn() };

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
    broadcast.getForegroundPushTokensInConversation.mockResolvedValue(
      new Map(),
    );
    push.listActiveTokensForUsers.mockImplementation((userIds: string[]) =>
      Promise.resolve(
        new Map(
          userIds.map((userId) => [
            userId,
            [{ token: 'ExponentPushToken[a]', projectId: null }],
          ]),
        ),
      ),
    );
    push.sendMessages.mockImplementation((messages: Array<{ token: string }>) =>
      Promise.resolve(
        messages.map((message) => ({ token: message.token, status: 'SENT' })),
      ),
    );
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

    expect(sentPayloads()).toEqual([expect.objectContaining({ badge: 7 })]);
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
    // token 一次查完、消息一次交给推送服务分批,不再每个收件人各查各发。
    expect(push.listActiveTokensForUsers).toHaveBeenCalledTimes(1);
    expect(pushedUserIds()).toHaveLength(1120);
    expect(push.sendMessages).toHaveBeenCalledTimes(1);
    expect(push.sendMessages.mock.calls[0][0]).toHaveLength(1120);
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
    expect(pushedUserIds()).toEqual(['u-peer']);
    expect(push.sendMessages).toHaveBeenCalledWith([
      {
        token: 'ExponentPushToken[a]',
        projectId: null,
        payload: expect.objectContaining({
          title: '发送者',
          body: 'hello world',
          data: expect.objectContaining({
            type: 'chat',
            conversationId: 'conv-1',
            sourceID: 'u-sender',
            conversationType: 'private',
          }),
        }),
      },
    ]);
  });

  // 按设备判断:只有正开着 App 的那台设备不推。电脑上开着网页版(没有推送 token)
  // 不能让手机也收不到;锁屏的手机照推。
  it('skips only the devices that have the app open', async () => {
    push.listActiveTokensForUsers.mockImplementation((userIds: string[]) =>
      Promise.resolve(
        new Map(
          userIds.map((userId) => [
            userId,
            [
              { token: `${userId}-phone`, projectId: null },
              { token: `${userId}-tablet`, projectId: null },
            ],
          ]),
        ),
      ),
    );
    prisma.chatMember.findMany.mockResolvedValue([
      seat('u-watching-on-phone'),
      seat('u-locked-screen'),
    ]);
    broadcast.getForegroundPushTokensInConversation.mockResolvedValue(
      new Map([
        ['u-watching-on-phone', new Set(['u-watching-on-phone-phone'])],
      ]),
    );

    await pushNow(msg());

    const tokens = push.sendMessages.mock.calls.flatMap(
      ([messages]: [Array<{ token: string }>]) =>
        messages.map((message) => message.token),
    );
    expect([...tokens].sort((a, b) => a.localeCompare(b))).toEqual([
      'u-locked-screen-phone',
      'u-locked-screen-tablet',
      'u-watching-on-phone-tablet',
    ]);
  });

  it('sends nothing to a member whose only device has the app open', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat('u-watching')]);
    broadcast.getForegroundPushTokensInConversation.mockResolvedValue(
      new Map([['u-watching', new Set(['ExponentPushToken[a]'])]]),
    );

    await pushNow(msg());

    expect(push.sendMessages).not.toHaveBeenCalled();
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
    expect(pushedUserIds()).toEqual(['u-muted-mentioned']);

    push.listActiveTokensForUsers.mockClear();
    await pushNow(
      msg({ id: 'msg-2', content: { text: 'all hands', atAll: true } }),
    );
    expect(pushedUserIds()).toHaveLength(2);
  });

  describe('delivery options', () => {
    it('uses the high-priority chat channel with one notification stream per conversation', async () => {
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await pushNow(msg());

      // 安卓默认 normal 优先级在省电模式下会被延后;tag 让同一会话的新通知
      // 替换旧的,threadId 让 iOS 按会话分组;过期的聊天通知不再补发。
      expect(sentPayloads()).toEqual([
        expect.objectContaining({
          priority: 'high',
          channelId: 'chat',
          tag: 'conv-1',
          threadId: 'conv-1',
          ttl: 24 * 60 * 60,
          data: expect.objectContaining({ messageId: 'msg-1' }),
        }),
      ]);
    });

    it('never puts the text of a disappearing message on the lock screen', async () => {
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await pushNow(
        msg({ burnDurationSec: 300, content: { text: '只给你看的内容' } }),
      );

      const [payload] = sentPayloads();
      // 焚毁之后通知栏里的原文还在,等于没烧;过了焚毁时限也不该再补发。
      expect(payload).toEqual(
        expect.objectContaining({ body: '[阅后即焚消息]', ttl: 300 }),
      );
      expect(JSON.stringify(payload)).not.toContain('只给你看的内容');
    });

    it('keeps a mention in its own notification so later chatter cannot replace it', async () => {
      push.listActiveTokensForUsers.mockImplementation((userIds: string[]) =>
        Promise.resolve(
          new Map(
            userIds.map((userId) => [
              userId,
              [{ token: `tok-${userId}`, projectId: null }],
            ]),
          ),
        ),
      );
      prisma.chatMember.findMany.mockResolvedValue([
        seat('u-mentioned'),
        seat('u-other'),
      ]);

      await pushNow(
        msg({
          content: {
            text: '@小方 看一下',
            mentions: [{ userId: 'u-mentioned' }],
          },
        }),
      );

      const tags = new Map(
        push.sendMessages.mock.calls.flatMap(
          ([messages]: [Array<{ token: string; payload: { tag: string } }>]) =>
            messages.map((message) => [message.token, message.payload.tag]),
        ),
      );
      expect(tags.get('tok-u-mentioned')).toBe('conv-1:mention');
      expect(tags.get('tok-u-other')).toBe('conv-1');
    });
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

      expect(push.sendMessages).toHaveBeenCalledTimes(1);
      expect(sentPayloads()).toEqual([
        expect.objectContaining({ body: 'third' }),
      ]);
    });

    it('does not slide the window, so a busy chat still pushes about once a window', async () => {
      jest.useFakeTimers();
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await service.onMessageBroadcast(msg({ id: 'm5', height: 5 }));
      jest.advanceTimersByTime(CHAT_PUSH_COALESCE_MS - 100);
      await service.onMessageBroadcast(msg({ id: 'm6', height: 6 }));
      jest.advanceTimersByTime(100);
      await service.flushPending();
      expect(push.sendMessages).toHaveBeenCalledTimes(1);

      await service.onMessageBroadcast(msg({ id: 'm7', height: 7 }));
      await service.flushPending();
      expect(push.sendMessages).toHaveBeenCalledTimes(2);
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

      expect(push.sendMessages).toHaveBeenCalledTimes(2);
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
      expect(push.sendMessages).toHaveBeenCalledTimes(1);
      expect(sentPayloads()).toEqual([
        expect.objectContaining({ body: '@你 看一下' }),
      ]);
    });

    it('skips members who read or cleared the message elsewhere before the window closed', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        seat('u-read-on-desktop', { lastReadHeight: 5 }),
        seat('u-cleared', { clearedBeforeHeight: 5 }),
        seat('u-behind', { lastReadHeight: 4 }),
      ]);

      await pushNow(msg({ height: 5 }));

      expect(pushedUserIds()).toEqual(['u-behind']);
    });

    it('never pushes the content of a message recalled before the window closed', async () => {
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);
      prisma.chatMessage.findMany.mockResolvedValue([
        { id: 'msg-1', revokedAt: new Date(), deleted: false },
      ]);

      await pushNow(msg());

      expect(push.sendMessages).not.toHaveBeenCalled();
    });

    it('flushes pending windows on shutdown', async () => {
      jest.useFakeTimers();
      prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);

      await service.onMessageBroadcast(msg());
      await service.onModuleDestroy();

      expect(push.sendMessages).toHaveBeenCalledTimes(1);
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

    expect(sentPayloads()).toEqual([
      expect.objectContaining({
        title: '登山圈',
        body: '发送者: [图片]',
        data: expect.objectContaining({
          sourceID: 'circle-1',
          conversationType: 'group',
        }),
      }),
    ]);
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

    expect(sentPayloads()).toEqual([
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
    ]);
  });

  it('never throws upward even when the pipeline fails', async () => {
    prisma.chatMember.findMany.mockRejectedValue(new Error('db down'));
    await expect(pushNow(msg())).resolves.toBeUndefined();
    expect(push.sendMessages).not.toHaveBeenCalled();
  });

  it('skips members without any active token', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat('u-peer')]);
    push.listActiveTokensForUsers.mockResolvedValue(new Map());
    await pushNow(msg());
    expect(push.sendMessages).not.toHaveBeenCalled();
  });

  // allSettled 会把每个收件人的失败原样吞掉:不看返回值的话,供应商或数据库
  // 整体故障时 dispatch 照样"成功"返回,外层失败日志一次都不触发 —— 整场扇出
  // 静默蒸发,运维侧没有任何信号。
  it('logs a bounded summary when every recipient fails', async () => {
    prisma.chatMember.findMany.mockResolvedValueOnce([seat('u2'), seat('u3')]);
    push.sendMessages.mockImplementation((messages: Array<{ token: string }>) =>
      Promise.resolve(
        messages.map((message) => ({
          token: message.token,
          status: 'RETRYABLE',
          error: 'provider down',
        })),
      ),
    );
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (service as unknown as { logger: typeof logger }).logger = logger;

    await pushNow(msg());

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('2/2 recipients failed'),
    );
    // 3000 人的群失败不能刷 3000 行:只汇总一条。
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('logs the whole fanout as failed when the token lookup itself fails', async () => {
    prisma.chatMember.findMany.mockResolvedValueOnce([seat('u2'), seat('u3')]);
    push.listActiveTokensForUsers.mockRejectedValue(new Error('db down'));
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
    (service as unknown as { logger: typeof logger }).logger = logger;

    await expect(pushNow(msg())).resolves.toBeUndefined();

    expect(push.sendMessages).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('2/2 recipients failed'),
    );
  });
});
