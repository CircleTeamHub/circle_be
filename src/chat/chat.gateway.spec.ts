import { ForbiddenException } from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGateway } from './chat.gateway';

type Handler = (...args: unknown[]) => void;

function fakeSocket(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  return {
    id: 'socket-1',
    data: { userId: 'u1' },
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
  const jwtService = { verify: jest.fn() };
  const sessionRevocation = { isRevoked: jest.fn() };
  const chatService = {
    listConversationIds: jest.fn(),
    sendMessage: jest.fn(),
    markRead: jest.fn(),
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

  const gateway = new ChatGateway(
    jwtService as never,
    sessionRevocation as never,
    chatService as never,
    broadcast as never,
    chatPush as never,
    redisService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    sessionRevocation.isRevoked.mockResolvedValue(false);
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
      chatService.markRead.mockResolvedValue(true);
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
      chatService.markRead.mockResolvedValue(false);
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
