import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import { SESSION_REVOCATION_CHANNEL } from 'src/auth/session-revocation.broadcast';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * In-process stand-in for Redis pub/sub. `publish` fans out to every handler
 * registered via `subscribePattern`, exactly like a real Redis backplane does
 * across instances (including back to the publishing process, which subscribes
 * on a separate connection). Two RealtimeService instances sharing one bus is
 * therefore a faithful model of two app instances sharing one Redis.
 */
function createRedisBus(enabled = true) {
  const subscribers: Array<{
    pattern: string;
    handler: (channel: string, message: string) => void;
  }> = [];
  const store = new Map<string, unknown>();

  // The service only ever psubscribes exact names or a trailing-`*` prefix,
  // which is all this needs to model.
  const matches = (pattern: string, channel: string) => {
    const star = pattern.indexOf('*');
    return star === -1
      ? pattern === channel
      : channel.startsWith(pattern.slice(0, star));
  };

  return {
    isEnabled: jest.fn(() => enabled),
    publish: jest.fn(async (channel: string, message: string) => {
      if (!enabled) return false;
      for (const sub of subscribers) {
        if (matches(sub.pattern, channel)) sub.handler(channel, message);
      }
      return true;
    }),
    subscribePattern: jest.fn(
      async (
        pattern: string,
        handler: (channel: string, message: string) => void,
      ) => {
        if (!enabled) return false;
        subscribers.push({ pattern, handler });
        return true;
      },
    ),
    setJson: jest.fn(async (key: string, value: unknown) => {
      if (!enabled) return false;
      store.set(key, value);
      return true;
    }),
    getJson: jest.fn(async (key: string) =>
      enabled ? (store.get(key) ?? null) : null,
    ),
    getJsonWithVersion: jest.fn().mockResolvedValue(null),
    setJsonIfNewer: jest.fn().mockResolvedValue(true),
    getVersion: jest.fn().mockResolvedValue(''),
    setJsonIfVersionMatches: jest.fn().mockResolvedValue(true),
    invalidateVersionedKey: jest.fn().mockResolvedValue(true),
    deleteKey: jest.fn().mockResolvedValue(true),
  };
}

function createPrismaStub() {
  return {
    friendActivity: { count: jest.fn().mockResolvedValue(0) },
    circlePostSignup: { count: jest.fn().mockResolvedValue(0) },
    notification: { count: jest.fn().mockResolvedValue(0) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    userDisplayIcon: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

type ClosePayload = { code: number; reason: string };

function waitForClose(socket: WebSocket): Promise<ClosePayload> {
  return new Promise((resolve) => {
    socket.on('close', (code, reason) =>
      resolve({ code, reason: reason.toString('utf8') }),
    );
  });
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString('utf8')));
      } catch (error) {
        reject(error as Error);
      }
    });
  });
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RealtimeGateway session revocation', () => {
  let httpServer: Server;
  let gateway: RealtimeGateway;
  let realtime: RealtimeService;
  let revocation: SessionRevocationService;
  let redis: ReturnType<typeof createRedisBus>;
  let port: number;
  const openSockets: WebSocket[] = [];

  // Tokens are plain JSON here; the JwtService stub "verifies" by parsing.
  const jwtService = {
    verify: jest.fn((token: string) => JSON.parse(token) as unknown),
  };

  const signToken = (payload: Record<string, unknown>) =>
    JSON.stringify({ accountId: 'acct-1', ...payload });

  async function boot(bus: ReturnType<typeof createRedisBus>) {
    redis = bus;
    realtime = new RealtimeService(
      createPrismaStub() as unknown as PrismaService,
      redis as unknown as RedisService,
    );
    await realtime.onModuleInit();

    revocation = new SessionRevocationService(
      redis as unknown as RedisService,
      {
        get: jest.fn().mockReturnValue('1h'),
      } as never,
    );

    gateway = new RealtimeGateway(
      jwtService as never,
      realtime,
      revocation as never,
    );

    httpServer = createServer();
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    port = (httpServer.address() as AddressInfo).port;
    gateway.attach(httpServer);
  }

  /** Connects, authenticates, and resolves once the server has registered it. */
  async function connectAuthenticated(
    payload: Record<string, unknown>,
  ): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const firstMessage = waitForMessage(socket);
    socket.send(JSON.stringify({ type: 'auth', token: signToken(payload) }));
    // The gateway emits a badge snapshot right after registering the client,
    // so receiving it proves the socket is fully authenticated and tracked.
    await firstMessage;
    return socket;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jwtService.verify.mockImplementation(
      (token: string) => JSON.parse(token) as unknown,
    );
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.terminate();
    gateway?.onModuleDestroy();
    realtime?.onModuleDestroy();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  describe('with Redis enabled', () => {
    beforeEach(async () => {
      await boot(createRedisBus(true));
    });

    it('rejects a socket authenticating with an already-revoked token', async () => {
      await revocation.revokeUser('banned-user');

      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const closed = waitForClose(socket);
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: signToken({
            sub: 'banned-user',
            sid: 'session-1',
            issuedAtMs: Date.now() - 5_000,
          }),
        }),
      );

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: 'Session revoked',
      });
    });

    it('closes an already-connected socket when the user is revoked', async () => {
      const socket = await connectAuthenticated({
        sub: 'user-1',
        sid: 'session-1',
        issuedAtMs: Date.now() - 5_000,
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const closed = waitForClose(socket);
      await revocation.revokeUser('user-1');

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: 'Session revoked',
      });
    });

    it('closes a socket held on another instance (cross-instance)', async () => {
      // `realtime` (instance B) holds the socket. `instanceA` shares only the
      // Redis bus and holds nothing, standing in for the instance that
      // processed the ban.
      const instanceA = new RealtimeService(
        createPrismaStub() as unknown as PrismaService,
        redis as unknown as RedisService,
      );
      await instanceA.onModuleInit();

      const socket = await connectAuthenticated({
        sub: 'user-2',
        sid: 'session-2',
        issuedAtMs: Date.now() - 5_000,
      });
      expect(realtime.getConnectionCount('user-2')).toBe(1);
      expect(instanceA.getConnectionCount('user-2')).toBe(0);

      const closed = waitForClose(socket);
      await revocation.revokeUser('user-2');

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: 'Session revoked',
      });
      instanceA.onModuleDestroy();
    });

    it('closes only the revoked session, leaving the user other devices', async () => {
      const issuedAtMs = Date.now() - 5_000;
      const deviceOne = await connectAuthenticated({
        sub: 'user-3',
        sid: 'session-a',
        issuedAtMs,
      });
      const deviceTwo = await connectAuthenticated({
        sub: 'user-3',
        sid: 'session-b',
        issuedAtMs,
      });

      const closed = waitForClose(deviceOne);
      await revocation.revokeSession('session-a');

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: 'Session revoked',
      });
      await tick();
      expect(deviceTwo.readyState).toBe(WebSocket.OPEN);
    });

    it('does not close an unrelated user socket', async () => {
      const victim = await connectAuthenticated({
        sub: 'user-4',
        sid: 'session-4',
        issuedAtMs: Date.now() - 5_000,
      });
      const bystander = await connectAuthenticated({
        sub: 'user-5',
        sid: 'session-5',
        issuedAtMs: Date.now() - 5_000,
      });

      const closed = waitForClose(victim);
      await revocation.revokeUser('user-4');
      await closed;
      await tick();

      expect(bystander.readyState).toBe(WebSocket.OPEN);
    });

    it('does not register a socket that dies during the revocation check', async () => {
      // The revocation lookup sits between auth and registration; a client that
      // disconnects inside that window must not be left in the client map,
      // which would burn one of its user's connection slots for good.
      let releaseCheck = () => {};
      const checkStarted = new Promise<void>((resolve) => {
        jest.spyOn(revocation, 'isRevoked').mockImplementation(async () => {
          resolve();
          await new Promise<void>((r) => (releaseCheck = r));
          return false;
        });
      });

      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: signToken({ sub: 'user-8', sid: 'session-8', iat: 1 }),
        }),
      );

      await checkStarted;
      socket.terminate();
      await tick();
      releaseCheck();
      await tick();

      expect(realtime.getConnectionCount('user-8')).toBe(0);
    });

    it('keeps a session established after the revoke stamp (re-login race)', async () => {
      // Mirrors `isRevoked`: the per-user marker only kills tokens issued at or
      // before the revoke instant. A device that logged back in afterwards must
      // survive, otherwise "log out all devices" would kick the new session.
      await revocation.revokeUser('user-6');
      const socket = await connectAuthenticated({
        sub: 'user-6',
        sid: 'session-6',
        issuedAtMs: Date.now() + 5_000,
      });

      await tick();
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('fail-open when Redis is disabled', () => {
    beforeEach(async () => {
      await boot(createRedisBus(false));
    });

    it('still accepts connections and closes nothing on revoke', async () => {
      const socket = await connectAuthenticated({
        sub: 'user-7',
        sid: 'session-7',
        issuedAtMs: Date.now() - 5_000,
      });

      await revocation.revokeUser('user-7');
      await revocation.revokeSession('session-7');
      await tick();

      expect(socket.readyState).toBe(WebSocket.OPEN);
      const revocationPublishes = redis.publish.mock.calls.filter(
        ([channel]) => channel === SESSION_REVOCATION_CHANNEL,
      );
      expect(revocationPublishes).toHaveLength(0);
    });
  });
});
