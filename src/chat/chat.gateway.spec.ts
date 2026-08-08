import { ForbiddenException } from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGateway } from './chat.gateway';

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
  const redisService = { subscribePattern: jest.fn().mockResolvedValue(true) };
  const configService = { get: jest.fn().mockReturnValue('guest-secret') };

  const gateway = new ChatGateway(
    jwtService as never,
    sessionRevocation as never,
    chatService as never,
    broadcast as never,
    chatPush as never,
    redisService as never,
    configService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    sessionRevocation.isRevoked.mockResolvedValue(false);
    configService.get.mockReturnValue('guest-secret');
    // 默认不是访客 token:app 分支的既有用例不受分流影响。
    jwtService.decode.mockReturnValue({ sub: 'u1' });
  });

  describe('authenticate', () => {
    it('accepts a valid access token and returns the userId', async () => {
      jwtService.verify.mockReturnValue({ sub: 'u1', accountId: 'acc1' });
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

      jwtService.verify.mockReturnValue({ sub: 'u1', accountId: 'acc1' });
      sessionRevocation.isRevoked.mockResolvedValue(true);
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
    });

    it('disconnects instead of leaving a silent no-room connection on join failure', async () => {
      const socket = fakeSocket();
      chatService.listConversationIds.mockRejectedValue(new Error('db down'));
      await gateway['handleConnection'](socket as never);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.handlers.size).toBe(0);
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
    });

    it('rate limits per socket with an explicit ack code', async () => {
      chatService.sendMessage.mockResolvedValue({
        reused: false,
        message: { id: 'm', conversationId: 'conv-1', height: 1, d: 'd' },
      });
      const socket = fakeSocket({ id: 'flooder' });
      const acks: unknown[] = [];
      for (let i = 0; i < 21; i += 1) {
        await gateway['handleSend'](
          socket as never,
          'u1',
          payload as never,
          (a: unknown) => acks.push(a),
        );
      }
      expect(acks[20]).toMatchObject({
        ok: false,
        code: ChatErrorCode.RateLimited,
      });
      expect(chatService.sendMessage).toHaveBeenCalledTimes(20);
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
