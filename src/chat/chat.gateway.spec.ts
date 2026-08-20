import { ForbiddenException, HttpException } from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGateway } from './chat.gateway';
import type { ChatMetrics } from './chat-metrics';
import * as errorAggregation from '../logging/error-aggregation.service';

type Handler = (...args: unknown[]) => void;

function fakeSocket(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  return {
    id: 'socket-1',
    // 网关会往 data 上钉 guestConversationId / sessionId / issuedAtMs。
    data: { userId: 'u1' } as Record<string, unknown>,
    rooms: new Set<string>(['socket-1', 'c:conv-1']),
    handshake: { auth: { token: 'jwt' } },
    join: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    disconnected: false,
    on: jest.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    handlers,
    ...overrides,
  };
}

describe('ChatGateway', () => {
  const jwtService = { verify: jest.fn(), decode: jest.fn() };
  const sessionRevocation = { isRevoked: jest.fn() };
  const chatService = {
    listConversationIds: jest.fn(),
    sendMessage: jest.fn(),
    markRead: jest.fn(),
    getActiveTempChat: jest.fn(),
    hasSeat: jest.fn(),
    filterVisiblePresenceTargets: jest.fn(),
    // 上下线广播要剔掉互相拉黑的人;默认无拉黑关系。
    listBlockedCounterparties: jest.fn().mockResolvedValue([]),
  };
  const broadcast = {
    setServer: jest.fn(),
    emitMessage: jest.fn(),
    emitRead: jest.fn(),
    emitTyping: jest.fn(),
    emitPresence: jest.fn(),
    isUserOnline: jest.fn().mockResolvedValue(false),
  };

  const chatPush = {
    onMessageBroadcast: jest.fn().mockResolvedValue(undefined),
  };
  const redisService = {
    subscribePattern: jest.fn().mockResolvedValue(true),
    isEnabled: jest.fn().mockReturnValue(false),
    // Redis 缺省:限流回退本地、注册表全 null、adapter 不挂 —— 单实例语义。
    slidingWindowAcquire: jest.fn().mockResolvedValue(null),
    getAdapterClients: jest.fn().mockResolvedValue(null),
  };
  const configService = { get: jest.fn().mockReturnValue('guest-secret') };
  const presence = {
    registerSocket: jest.fn().mockResolvedValue(null),
    registerConversations: jest.fn().mockResolvedValue(undefined),
    socketDisconnected: jest.fn().mockResolvedValue(undefined),
    conversationJoined: jest.fn().mockResolvedValue(undefined),
    conversationLeft: jest.fn().mockResolvedValue(undefined),
    getOnlineUserIds: jest.fn().mockResolvedValue(null),
    isOnline: jest.fn().mockResolvedValue(null),
  };
  const metrics: jest.Mocked<ChatMetrics> = {
    registry: {} as ChatMetrics['registry'],
    observeConnectionOpened: jest.fn(),
    observeConnectionClosed: jest.fn(),
    observeConnectionRejected: jest.fn(),
    observeAuthFailure: jest.fn(),
    observeEvent: jest.fn(),
    observeAckDuration: jest.fn(),
    observeBroadcast: jest.fn(),
  };

  const gateway = new ChatGateway(
    jwtService as never,
    sessionRevocation as never,
    chatService as never,
    broadcast as never,
    chatPush as never,
    redisService as never,
    configService as never,
    presence as never,
  );
  (gateway as any).metrics = metrics;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionRevocation.isRevoked.mockResolvedValue(false);
    configService.get.mockReturnValue('guest-secret');
    // 默认不是访客 token:app 分支的既有用例不受分流影响。
    jwtService.decode.mockReturnValue({ sub: 'u1' });
    // clearAllMocks 会连实现一起清掉,这里重设默认「无拉黑关系」。
    chatService.listBlockedCounterparties.mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('authenticate', () => {
    it('accepts a valid access token and returns the userId', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        accountId: 'acc1',
        aud: 'APP',
      });
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBe('u1');
    });

    it('rejects missing/invalid/revoked tokens', async () => {
      await expect(
        gateway['authenticate'](
          fakeSocket({ handshake: { auth: {} } }) as never,
        ),
      ).resolves.toBeNull();

      jwtService.verify.mockImplementation(() => {
        throw new Error('bad signature');
      });
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();

      // 缺 accountId = 非 access token(如伪造载荷),同样拒绝。
      jwtService.verify.mockReturnValue({ sub: 'u1' });
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();

      jwtService.verify.mockReturnValue({
        sub: 'u1',
        accountId: 'acc1',
        aud: 'APP',
      });
      sessionRevocation.isRevoked.mockResolvedValue(true);
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
    });

    // 管理台走 /auth/admin/login 拿的是 ADMIN audience,它同样能过签名校验,
    // 而管理台压根没有消息 UI。拆 OpenIM 前这道闸在 /auth/im-token 里(显式拒
    // ADMIN),自研栈直接复用 app JWT 连 socket,闸随端点一起没了。
    it('rejects an admin-audience token (chat is an app-only capability)', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'admin-1',
        accountId: 'acc-admin',
        aud: 'ADMIN',
      });
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
      // 连吊销检查都不该走到 —— 这类 token 根本不该进入聊天面。
      expect(sessionRevocation.isRevoked).not.toHaveBeenCalled();
    });

    it('rejects a token with no audience claim at all', async () => {
      jwtService.verify.mockReturnValue({ sub: 'u1', accountId: 'acc1' });
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
    });
  });

  describe('authenticate (temp-chat guest)', () => {
    const guestPayload = {
      kind: 'temp-chat-guest',
      guestId: 'g1',
      tcId: 'tc-1',
      conversationId: 'conv-9',
    };

    beforeEach(() => {
      jwtService.decode.mockReturnValue({ kind: 'temp-chat-guest' });
      jwtService.verify.mockReturnValue(guestPayload);
      chatService.getActiveTempChat.mockResolvedValue(true);
      chatService.hasSeat.mockResolvedValue(true);
    });

    it('accepts a guest chatToken and pins it to its single conversation', async () => {
      const socket = fakeSocket();
      await expect(gateway['authenticate'](socket as never)).resolves.toBe(
        'g1',
      );
      // 用访客秘钥验签,不是 app 的 SECRET。
      expect(jwtService.verify).toHaveBeenCalledWith('jwt', {
        secret: 'guest-secret',
      });
      expect(socket.data.guestConversationId).toBe('conv-9');
      // 访客没有 app 会话,吊销广播的两个判据都不该命中它。
      expect(socket.data.sessionId).toBeNull();
      expect(socket.data.issuedAtMs).toBeNull();
      expect(sessionRevocation.isRevoked).not.toHaveBeenCalled();
    });

    it('rejects once the room is no longer active', async () => {
      chatService.getActiveTempChat.mockResolvedValue(false);
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
      expect(chatService.hasSeat).not.toHaveBeenCalled();
    });

    it('rejects a guest whose seat was cleared', async () => {
      chatService.hasSeat.mockResolvedValue(false);
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
    });

    it('rejects a forged kind claim (it still needs the guest signing key)', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('bad signature');
      });
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
    });

    it('rejects every guest handshake when the secret is unconfigured', async () => {
      configService.get.mockReturnValue(undefined);
      await expect(
        gateway['authenticate'](fakeSocket() as never),
      ).resolves.toBeNull();
      expect(jwtService.verify).not.toHaveBeenCalled();
    });
  });

  describe('handleConnection', () => {
    it('joins the personal room plus every membership conversation room', async () => {
      const socket = fakeSocket();
      chatService.listConversationIds.mockResolvedValue(['conv-1', 'conv-2']);
      await gateway['handleConnection'](socket as never);
      expect(socket.join).toHaveBeenCalledWith('u:u1');
      expect(socket.join).toHaveBeenCalledWith(['c:conv-1', 'c:conv-2']);
      expect(socket.handlers.has('chat:send')).toBe(true);
      expect(socket.handlers.has('chat:read')).toBe(true);
      expect(socket.handlers.has('chat:typing')).toBe(true);
      expect(metrics.observeConnectionOpened).toHaveBeenCalledWith(1);
    });

    it('disconnects instead of leaving a silent no-room connection on join failure', async () => {
      const report = jest
        .spyOn(errorAggregation, 'reportOperationalError')
        .mockImplementation(() => undefined);
      const socket = fakeSocket();
      chatService.listConversationIds.mockRejectedValue(new Error('db down'));
      await gateway['handleConnection'](socket as never);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(metrics.observeConnectionRejected).toHaveBeenCalledWith(
        'join_failed',
      );
      // 监听现在是同步注册的(在入房之前),所以这里不再断言 handlers 为空 ——
      // 要保证的是它们「注册了但不干活」:入房失败后事件一律不落到业务处理器。
      const ack = jest.fn();
      socket.handlers.get('chat:send')?.({ conversationId: 'c' }, ack);
      await Promise.resolve();
      await Promise.resolve();
      expect(chatService.sendMessage).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledWith(expect.any(Error), {
        component: 'ChatGateway',
        operation: 'joinRooms',
        kind: 'websocket',
      });
      report.mockRestore();
    });

    // 入房要 await,而监听若在 await 之后注册,这段窗口里到达的 chat:send
    // 没有任何监听者 —— Socket.IO 直接丢弃且不回 ack,客户端表现为「刚连上
    // 发的第一条消息石沉大海」。所以监听必须先于第一个 await 注册。
    // 查询侧已经按拉黑收口了,广播侧不收口等于换个通道把同一份信息免费送出去,
    // 而且是推的、连轮询都不用。拉黑不动 ChatMember,座位一直在。
    it('excludes blocked counterparties from the online broadcast', async () => {
      const socket = fakeSocket();
      chatService.listConversationIds.mockResolvedValue(['conv-1']);
      chatService.listBlockedCounterparties.mockResolvedValue(['blocked-1']);

      await gateway['handleConnection'](socket as never);

      expect(broadcast.emitPresence).toHaveBeenCalledWith(
        ['conv-1'],
        { userId: 'u1', online: true },
        ['blocked-1'],
      );
    });

    it('registers event handlers before awaiting room setup', async () => {
      const socket = fakeSocket();
      let handlersAtLookup = 0;
      chatService.listConversationIds.mockImplementation(() => {
        handlersAtLookup = socket.handlers.size;
        return Promise.resolve(['conv-1']);
      });
      await gateway['handleConnection'](socket as never);
      expect(handlersAtLookup).toBeGreaterThan(0);
    });

    it('registers and queues event handlers before awaiting global presence registration', async () => {
      const socket = fakeSocket();
      let finishRegistration!: (count: number | null) => void;
      presence.registerSocket.mockImplementationOnce(
        () =>
          new Promise<number | null>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      const handleSend = jest
        .spyOn(gateway as any, 'handleSend')
        .mockResolvedValue(undefined);

      const pending = gateway['handleConnection'](socket as never);
      const earlyHandler = socket.handlers.get('chat:send');
      expect(earlyHandler).toBeDefined();

      earlyHandler?.({ conversationId: 'conv-1' }, jest.fn());
      expect(handleSend).not.toHaveBeenCalled();

      finishRegistration(null);
      await pending;
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(1);
      handleSend.mockRestore();
    });

    // 就绪之后队列只为保序而存在:准入期攒下的积压还在排空时,后到的事件必须
    // 排在它后面,否则先发的消息会后落库。这时队满代表 drain 慢(数据库/Redis
    // 抖动),不代表客户端在洪泛 —— 各 handler 自己有限流器。把整条会话断开,
    // 等于把一次延迟事件放大成连接故障,还会丢掉已受理的那 64 条。
    it('rejects one event without dropping an established session when the drain backlog is full', async () => {
      const socket = fakeSocket({ disconnected: false });
      socket.disconnect.mockImplementation(() => {
        socket.disconnected = true;
      });
      let finishRegistration!: (count: number | null) => void;
      presence.registerSocket.mockImplementationOnce(
        () =>
          new Promise<number | null>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      // 排空时的第一条卡住,drain 就一直在跑,后到的事件只能排队。
      let releaseFirst!: () => void;
      const handleSend = jest
        .spyOn(gateway as any, 'handleSend')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseFirst = resolve;
            }),
        )
        .mockResolvedValue(undefined);

      const pending = gateway['handleConnection'](socket as never);
      const handler = socket.handlers.get('chat:send');
      handler?.({ conversationId: 'conv-lead' }, jest.fn());

      finishRegistration(null);
      await pending;
      await Promise.resolve();

      for (let i = 0; i < ChatGateway['MAX_PRE_READY_EVENTS']; i += 1) {
        handler?.({ conversationId: `conv-${i}` }, jest.fn());
      }
      const overflowAck = jest.fn();
      handler?.({ conversationId: 'conv-overflow' }, overflowAck);

      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.disconnected).toBe(false);
      expect(metrics.observeConnectionRejected).toHaveBeenCalledWith(
        'drain_backlog_overflow',
      );
      expect(metrics.observeConnectionRejected).not.toHaveBeenCalledWith(
        'pre_ready_overflow',
      );
      expect(overflowAck).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: ChatErrorCode.RateLimited }),
      );

      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 已受理的那批照常排空,不因为一次溢出被清掉。
      expect(handleSend.mock.calls.length).toBeGreaterThan(1);
      handleSend.mockRestore();
    });

    it('disconnects when the shared pre-ready queue exceeds its fixed cap', async () => {
      const socket = fakeSocket({ disconnected: false });
      socket.disconnect.mockImplementation(() => {
        socket.disconnected = true;
      });
      let finishRegistration!: (count: number | null) => void;
      presence.registerSocket.mockImplementationOnce(
        () =>
          new Promise<number | null>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      const handleSend = jest
        .spyOn(gateway as any, 'handleSend')
        .mockResolvedValue(undefined);

      const pending = gateway['handleConnection'](socket as never);
      const earlyHandler = socket.handlers.get('chat:send');
      const acknowledgements = Array.from({ length: 65 }, () => jest.fn());
      acknowledgements.forEach((ack, index) => {
        earlyHandler?.({ conversationId: `conv-${index}` }, ack);
      });

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(metrics.observeConnectionRejected).toHaveBeenCalledWith(
        'pre_ready_overflow',
      );
      expect(acknowledgements[64]).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: ChatErrorCode.RateLimited }),
      );
      finishRegistration(null);
      await pending;
      await Promise.resolve();
      expect(handleSend).not.toHaveBeenCalled();
      handleSend.mockRestore();
    });

    it('drains accepted pre-ready events sequentially after admission', async () => {
      const socket = fakeSocket();
      let finishRegistration!: (count: number | null) => void;
      let finishFirst!: () => void;
      presence.registerSocket.mockImplementationOnce(
        () =>
          new Promise<number | null>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      const handleSend = jest
        .spyOn(gateway as any, 'handleSend')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(undefined);

      const pending = gateway['handleConnection'](socket as never);
      const earlyHandler = socket.handlers.get('chat:send');
      earlyHandler?.({ conversationId: 'conv-first' }, jest.fn());
      earlyHandler?.({ conversationId: 'conv-second' }, jest.fn());

      finishRegistration(null);
      await pending;
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(1);

      finishFirst();
      await Promise.resolve();
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(2);
      handleSend.mockRestore();
    });

    it('keeps ready-time events behind the draining pre-ready FIFO', async () => {
      const socket = fakeSocket();
      let finishRegistration!: (count: number | null) => void;
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      presence.registerSocket.mockImplementationOnce(
        () =>
          new Promise<number | null>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      const handleSend = jest
        .spyOn(gateway as any, 'handleSend')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishSecond = resolve;
            }),
        )
        .mockResolvedValueOnce(undefined);

      const pending = gateway['handleConnection'](socket as never);
      const send = socket.handlers.get('chat:send');
      send?.({ conversationId: 'conv-first' }, jest.fn());
      send?.({ conversationId: 'conv-second' }, jest.fn());

      finishRegistration(null);
      await pending;
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(1);

      send?.({ conversationId: 'conv-third' }, jest.fn());
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(1);

      finishFirst();
      await Promise.resolve();
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(2);
      expect(handleSend.mock.calls[1][2]).toEqual(
        expect.objectContaining({ conversationId: 'conv-second' }),
      );

      finishSecond();
      await Promise.resolve();
      await Promise.resolve();
      expect(handleSend).toHaveBeenCalledTimes(3);
      expect(handleSend.mock.calls[2][2]).toEqual(
        expect.objectContaining({ conversationId: 'conv-third' }),
      );
      handleSend.mockRestore();
    });

    // 串行 drain 的代价是共享失败面:一条排队事件把 rejection 漏出来就会中止
    // 整个循环,而 admissionState 仍是 ready —— 没人再回来排空剩下的积压,那些
    // 消息既不执行也不回 ack。限流器的 tryAcquire 就在各 handler 的 try 之外,
    // Redis 抖一下就能触发。
    it('keeps draining the pre-ready queue after one event rejects', async () => {
      const socket = fakeSocket();
      let finishRegistration!: (count: number | null) => void;
      presence.registerSocket.mockImplementationOnce(
        () =>
          new Promise<number | null>((resolve) => {
            finishRegistration = resolve;
          }),
      );
      const handleSend = jest
        .spyOn(gateway as any, 'handleSend')
        .mockRejectedValueOnce(new Error('rate limiter unavailable'))
        .mockResolvedValueOnce(undefined);

      const pending = gateway['handleConnection'](socket as never);
      const earlyHandler = socket.handlers.get('chat:send');
      earlyHandler?.({ conversationId: 'conv-first' }, jest.fn());
      earlyHandler?.({ conversationId: 'conv-second' }, jest.fn());

      finishRegistration(null);
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handleSend).toHaveBeenCalledTimes(2);
      expect(handleSend.mock.calls[1][2]).toEqual(
        expect.objectContaining({ conversationId: 'conv-second' }),
      );
      handleSend.mockRestore();
    });

    // opened/closed 是一对 Gauge inc/dec。disconnect 监听器现在同步注册,早于
    // 全局上限那一步 —— 如果 opened 还留在 await 之后,被拒的连接就会只发 closed,
    // chat_connections_active 一路 dec 成负数。
    it('never emits a connection close without a matching open', async () => {
      const socket = fakeSocket();
      presence.registerSocket.mockResolvedValueOnce(999);

      await gateway['handleConnection'](socket as never);
      socket.handlers.get('disconnect')?.(undefined as never, jest.fn());

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(metrics.observeConnectionOpened).toHaveBeenCalledTimes(1);
      expect(metrics.observeConnectionClosed).toHaveBeenCalledTimes(1);
    });

    it('confines a guest socket to its own room and skips the membership lookup', async () => {
      const socket = fakeSocket({
        data: { userId: 'g1', guestConversationId: 'conv-9' },
      });
      await gateway['handleConnection'](socket as never);
      expect(chatService.listConversationIds).not.toHaveBeenCalled();
      expect(socket.join).toHaveBeenCalledWith(['c:conv-9']);
    });
  });

  describe('handlePresenceQuery', () => {
    it('only answers for users sharing a conversation with the requester', async () => {
      chatService.filterVisiblePresenceTargets.mockResolvedValue(['u2']);
      broadcast.isUserOnline.mockResolvedValue(true);
      const ack = jest.fn();

      await gateway['handlePresenceQuery'](
        fakeSocket() as never,
        { userIds: ['u2', 'stranger', 'blocked'] } as never,
        ack,
      );

      expect(chatService.filterVisiblePresenceTargets).toHaveBeenCalledWith(
        'u1',
        ['u2', 'stranger', 'blocked'],
      );
      // 不过滤的话,任何登录账号都能拿 UUID 长期轮询陌生人的在线状态。
      expect(ack).toHaveBeenCalledWith({ u2: true });
    });

    it('answers empty without touching presence when nothing was requested', async () => {
      const ack = jest.fn();
      await gateway['handlePresenceQuery'](
        fakeSocket() as never,
        { userIds: [] } as never,
        ack,
      );
      expect(ack).toHaveBeenCalledWith({});
      expect(chatService.filterVisiblePresenceTargets).not.toHaveBeenCalled();
    });
  });

  describe('handleSend', () => {
    const payload = {
      conversationId: 'conv-1',
      type: 'text',
      content: { text: 'hi' },
      d: 'd1',
    };

    it('acks persisted message and broadcasts once', async () => {
      chatService.sendMessage.mockResolvedValue({
        reused: false,
        message: { id: 'msg-1', conversationId: 'conv-1', height: 7, d: 'd1' },
      });
      const ack = jest.fn();
      await gateway['handleSend'](
        fakeSocket() as never,
        'u1',
        payload as never,
        ack,
      );
      expect(ack).toHaveBeenCalledWith({
        ok: true,
        messageId: 'msg-1',
        height: 7,
        d: 'd1',
      });
      expect(broadcast.emitMessage).toHaveBeenCalledTimes(1);
      expect(metrics.observeEvent).toHaveBeenCalledWith('send', 'success');
      expect(metrics.observeBroadcast).toHaveBeenCalledWith(
        'message',
        expect.any(Number),
      );
    });

    it('does not rebroadcast idempotent replays', async () => {
      chatService.sendMessage.mockResolvedValue({
        reused: true,
        message: { id: 'msg-1', conversationId: 'conv-1', height: 7, d: 'd1' },
      });
      const ack = jest.fn();
      await gateway['handleSend'](
        fakeSocket() as never,
        'u1',
        payload as never,
        ack,
      );
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
      expect(broadcast.emitMessage).not.toHaveBeenCalled();
    });

    it('maps service errorCode exceptions into the ack instead of throwing', async () => {
      const report = jest
        .spyOn(errorAggregation, 'reportOperationalError')
        .mockImplementation(() => undefined);
      chatService.sendMessage.mockRejectedValue(
        new ForbiddenException({
          message: '不是会话成员',
          errorCode: ChatErrorCode.NotMember,
        }),
      );
      const ack = jest.fn();
      await gateway['handleSend'](
        fakeSocket() as never,
        'u1',
        payload as never,
        ack,
      );
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, code: ChatErrorCode.NotMember }),
      );
      expect(broadcast.emitMessage).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      report.mockRestore();
    });

    it('reports a 5xx HttpException even when its body includes an errorCode', async () => {
      const report = jest
        .spyOn(errorAggregation, 'reportOperationalError')
        .mockImplementation(() => undefined);
      chatService.sendMessage.mockRejectedValue(
        new HttpException(
          {
            message: 'database failed',
            errorCode: ChatErrorCode.InvalidPayload,
          },
          500,
        ),
      );
      const ack = jest.fn();

      await gateway['handleSend'](
        fakeSocket() as never,
        'u1',
        payload as never,
        ack,
      );

      expect(report).toHaveBeenCalledWith(expect.any(HttpException), {
        component: 'ChatGateway',
        operation: 'send',
        kind: 'websocket',
      });
      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          code: ChatErrorCode.InvalidPayload,
        }),
      );
      report.mockRestore();
    });

    it('reports an unexpected send failure without user, conversation, or message content', async () => {
      const report = jest
        .spyOn(errorAggregation, 'reportOperationalError')
        .mockImplementation(() => undefined);
      chatService.sendMessage.mockRejectedValue(
        new Error('private message blue pineapple'),
      );
      const ack = jest.fn();

      await gateway['handleSend'](
        fakeSocket() as never,
        'unexpected-user',
        payload as never,
        ack,
      );

      expect(report).toHaveBeenCalledWith(expect.any(Error), {
        component: 'ChatGateway',
        operation: 'send',
        kind: 'websocket',
      });
      expect(JSON.stringify(report.mock.calls[0]?.[1])).not.toMatch(
        /unexpected-user|conv-1|blue pineapple|hi/,
      );
      report.mockRestore();
    });

    it('rate limits per authenticated user with an explicit ack code', async () => {
      chatService.sendMessage.mockResolvedValue({
        reused: false,
        message: { id: 'm', conversationId: 'conv-1', height: 1, d: 'd' },
      });
      const socket = fakeSocket({ id: 'flooder' });
      const acks: unknown[] = [];
      for (let i = 0; i < 21; i += 1) {
        await gateway['handleSend'](
          socket as never,
          'flood-user',
          payload as never,
          (a: unknown) => acks.push(a),
        );
      }
      expect(acks[20]).toMatchObject({
        ok: false,
        code: ChatErrorCode.RateLimited,
      });
      expect(chatService.sendMessage).toHaveBeenCalledTimes(20);
      expect(metrics.observeEvent).toHaveBeenCalledWith('send', 'rate_limited');
    });

    // 配额按用户算,不按连接算。按 socket.id 计数的话,发满就重连是一个免费的
    // 配额重置 —— 限流形同虚设。换一条 socket 继续发,必须仍然被拒。
    it('keeps the budget across reconnects (a new socket does not reset it)', async () => {
      chatService.sendMessage.mockResolvedValue({
        reused: false,
        message: { id: 'm', conversationId: 'conv-1', height: 1, d: 'd' },
      });
      for (let i = 0; i < 20; i += 1) {
        await gateway['handleSend'](
          fakeSocket({ id: `sock-${i}` }) as never,
          'reconnect-user',
          payload as never,
          () => {},
        );
      }
      chatService.sendMessage.mockClear();

      const ack = jest.fn();
      await gateway['handleSend'](
        fakeSocket({ id: 'brand-new-socket' }) as never,
        'reconnect-user',
        payload as never,
        ack,
      );

      expect(ack).toHaveBeenCalledWith(
        expect.objectContaining({ code: ChatErrorCode.RateLimited }),
      );
      expect(chatService.sendMessage).not.toHaveBeenCalled();
    });

    it('survives a missing ack callback', async () => {
      chatService.sendMessage.mockResolvedValue({
        reused: false,
        message: { id: 'msg-1', conversationId: 'conv-1', height: 7, d: 'd1' },
      });
      await expect(
        gateway['handleSend'](fakeSocket() as never, 'u1', payload as never),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleRead', () => {
    it('acks and broadcasts only when the watermark advanced', async () => {
      chatService.markRead.mockResolvedValue({ advanced: true, height: 5 });
      const ack = jest.fn();
      await gateway['handleRead'](
        fakeSocket() as never,
        'u1',
        { conversationId: 'conv-1', height: 5 },
        ack,
      );
      expect(ack).toHaveBeenCalledWith({ ok: true });
      expect(broadcast.emitRead).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        userId: 'u1',
        height: 5,
      });

      broadcast.emitRead.mockClear();
      chatService.markRead.mockResolvedValue({ advanced: false, height: 4 });
      await gateway['handleRead'](
        fakeSocket() as never,
        'u1',
        { conversationId: 'conv-1', height: 4 },
        jest.fn(),
      );
      expect(broadcast.emitRead).not.toHaveBeenCalled();
    });
  });

  describe('handleTyping', () => {
    it('forwards typing only for rooms the socket actually joined', async () => {
      await gateway['handleTyping'](fakeSocket() as never, 'u1', {
        conversationId: 'conv-1',
      });
      expect(broadcast.emitTyping).toHaveBeenCalledWith(
        { conversationId: 'conv-1', userId: 'u1' },
        'socket-1',
      );

      broadcast.emitTyping.mockClear();
      await gateway['handleTyping'](fakeSocket() as never, 'u1', {
        conversationId: 'conv-other',
      });
      expect(broadcast.emitTyping).not.toHaveBeenCalled();
    });
  });
});
