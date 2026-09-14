import { Logger } from '@nestjs/common';
import { createServer, type Server } from 'http';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import {
  SessionRevocationService,
  type RevocationState,
} from 'src/auth/session-revocation.service';
import { SessionVerifier } from 'src/auth/session-verifier.service';
import { SESSION_REVOCATION_CHANNEL } from 'src/auth/session-revocation.broadcast';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import * as errorAggregation from '../logging/error-aggregation.service';

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
    setNumericMax: jest.fn(async (key: string, value: number) => {
      if (!enabled) return false;
      const current = store.get(key);
      if (typeof current !== 'number' || value > current) {
        store.set(key, value);
      }
      return true;
    }),
    getJson: jest.fn(async (key: string) =>
      enabled ? (store.get(key) ?? null) : null,
    ),
    getJsonMany: jest.fn(async (keys: string[]) =>
      enabled
        ? keys.map((key) => store.get(key) ?? null)
        : keys.map(() => null),
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

/**
 * The database view SessionVerifier falls back to when Redis cannot answer.
 * Defaults to an ACTIVE account whose session row was already cleaned up.
 */
function createVerifierPrismaStub() {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    refreshToken: { findUnique: jest.fn().mockResolvedValue(null) },
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
  let verifierPrisma: ReturnType<typeof createVerifierPrismaStub>;
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

    verifierPrisma = createVerifierPrismaStub();
    gateway = new RealtimeGateway(
      jwtService as never,
      realtime,
      new SessionVerifier(
        revocation,
        verifierPrisma as unknown as PrismaService,
      ),
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

    it('reports an initial snapshot failure without attaching the user id', async () => {
      const report = jest
        .spyOn(errorAggregation, 'reportOperationalError')
        .mockImplementation(() => undefined);
      jest
        .spyOn(realtime, 'emitSnapshot')
        .mockRejectedValue(new Error('private snapshot blue pineapple'));
      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });

      socket.send(
        JSON.stringify({
          type: 'auth',
          token: signToken({ sub: 'private-user', sid: 'session-1' }),
        }),
      );
      await tick();

      expect(report).toHaveBeenCalledWith(expect.any(Error), {
        component: 'RealtimeGateway',
        operation: 'emitSnapshot',
        kind: 'websocket',
      });
      expect(JSON.stringify(report.mock.calls[0]?.[1])).not.toContain(
        'private-user',
      );
      report.mockRestore();
    });

    it('logs an admission failure without Sentry or account identifiers', async () => {
      errorAggregation.configureErrorAggregationProvider(
        new errorAggregation.NoopErrorAggregationProvider(),
      );
      const logError = jest
        .spyOn((gateway as any).logger, 'error')
        .mockImplementation(() => undefined);
      jest.spyOn(realtime, 'registerPendingClient').mockImplementation(() => {
        throw new Error(
          'admission failed for private-user token=private-token',
        );
      });
      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const closed = waitForClose(socket);
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: signToken({ sub: 'private-user', sid: 'session-1' }),
        }),
      );

      await expect(closed).resolves.toEqual({
        code: 1011,
        reason: 'Internal error',
      });
      expect(logError).toHaveBeenCalledWith('Realtime socket admission failed');
      expect(JSON.stringify(logError.mock.calls)).not.toContain('private-user');
      expect(JSON.stringify(logError.mock.calls)).not.toContain(
        'private-token',
      );
      logError.mockRestore();
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
        jest
          .spyOn(revocation, 'checkRevocation')
          .mockImplementation(async (): Promise<RevocationState> => {
            resolve();
            await new Promise<void>((r) => (releaseCheck = r));
            return 'active';
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

    it('rejects a revocation published while the initial marker check is in flight', async () => {
      // Reproduce the ordering that loses a broadcast: the Redis GET has already
      // observed "not revoked", but its promise has not resumed registration yet.
      // The revoke SET + publish therefore arrives while no local socket is tracked.
      const originalCheck = revocation.checkRevocation.bind(revocation);
      let releaseCheck = () => {};
      const checkStarted = new Promise<void>((resolve) => {
        jest
          .spyOn(revocation, 'checkRevocation')
          .mockImplementationOnce(async (): Promise<RevocationState> => {
            resolve();
            await new Promise<void>((r) => (releaseCheck = r));
            return 'active';
          })
          .mockImplementation(originalCheck);
      });

      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const closed = waitForClose(socket);
      const firstMessage = waitForMessage(socket);
      const outcome = Promise.race([
        closed.then((payload) => ({ kind: 'closed', payload })),
        firstMessage.then((message) => ({ kind: 'message', message })),
      ]);
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: signToken({
            sub: 'user-race',
            sid: 'session-race',
            issuedAtMs: Date.now() - 5_000,
          }),
        }),
      );

      await checkStarted;
      await revocation.revokeUser('user-race');
      expect(realtime.getConnectionCount('user-race')).toBe(0);
      releaseCheck();

      await expect(outcome).resolves.toEqual({
        kind: 'closed',
        payload: { code: 1008, reason: 'Session revoked' },
      });
    });

    it('unregisters a token that expires during the revocation lookup', async () => {
      jest
        .spyOn(revocation, 'checkRevocation')
        .mockImplementation(async (): Promise<RevocationState> => {
          await tick(80);
          return 'active';
        });

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
            sub: 'user-expiring',
            sid: 'session-expiring',
            // Valid when verifyToken runs, expired by the time the awaited
            // revocation lookup returns and registration calculates its TTL.
            exp: Date.now() / 1000 + 0.05,
          }),
        }),
      );

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: 'Token expired',
      });
      await tick();
      expect(realtime.getConnectionCount('user-expiring')).toBe(0);
    });

    it('does not deliver private events while the final revocation check is pending', async () => {
      let releaseFinalCheck = (_state: RevocationState) => {};
      let callCount = 0;
      const finalCheckStarted = new Promise<void>((resolve) => {
        jest
          .spyOn(revocation, 'checkRevocation')
          .mockImplementation(async (): Promise<RevocationState> => {
            callCount += 1;
            if (callCount === 1) return 'active';
            resolve();
            return new Promise<RevocationState>((release) => {
              releaseFinalCheck = release;
            });
          });
      });

      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const received: unknown[] = [];
      socket.on('message', (data) => {
        received.push(JSON.parse(data.toString('utf8')));
      });
      const closed = waitForClose(socket);
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: signToken({
            sub: 'user-pending',
            sid: 'session-pending',
            issuedAtMs: Date.now() - 5_000,
          }),
        }),
      );

      await finalCheckStarted;
      expect(realtime.getConnectionCount('user-pending')).toBe(1);
      realtime.broadcastWalletBalanceChanged('user-pending');
      await tick();
      expect(received).toEqual([]);

      releaseFinalCheck('revoked');
      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: 'Session revoked',
      });
    });

    it('keeps the authentication deadline active until admission completes', async () => {
      jest.useFakeTimers();
      try {
        jest
          .spyOn(revocation, 'checkRevocation')
          .mockImplementation(() => new Promise<RevocationState>(() => {}));
        const socket = new EventEmitter() as EventEmitter & {
          close: jest.Mock;
          readyState: number;
          ping: jest.Mock;
        };
        socket.close = jest.fn();
        socket.readyState = WebSocket.OPEN;
        socket.ping = jest.fn();

        const pendingAdmission = (gateway as any).handleConnection(socket);
        expect(pendingAdmission).toBeInstanceOf(Promise);
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'auth',
              token: signToken({
                sub: 'user-stalled',
                sid: 'session-stalled',
                issuedAtMs: Date.now(),
              }),
            }),
          ),
        );
        await Promise.resolve();

        jest.advanceTimersByTime(10_000);

        expect(socket.close).toHaveBeenCalledWith(1008, 'Auth timeout');
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps a session established after the revoke stamp (re-login race)', async () => {
      // Mirrors `checkRevocation`: the per-user marker only kills tokens issued at or
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

  // Redis 没配或故障时吊销标记读不到。以前这里一律放行（fail-open）；现在与 HTTP
  // 共用 SessionVerifier：回落数据库核对账号状态与会话行。
  describe('database fallback when Redis is disabled', () => {
    beforeEach(async () => {
      await boot(createRedisBus(false));
    });

    async function authenticate(payload: Record<string, unknown>) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const closed = waitForClose(socket);
      socket.send(JSON.stringify({ type: 'auth', token: signToken(payload) }));
      return closed;
    }

    it('accepts an ACTIVE account and closes nothing on a Redis-only revoke', async () => {
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

    it('rejects a banned account at connect time with the revoked frame', async () => {
      verifierPrisma.user.findUnique.mockResolvedValue({ status: 'BANNED' });

      await expect(
        authenticate({
          sub: 'user-banned',
          sid: 'session-banned',
          issuedAtMs: Date.now() - 5_000,
        }),
      ).resolves.toEqual({ code: 1008, reason: 'Session revoked' });
      expect(realtime.getConnectionCount('user-banned')).toBe(0);
    });

    // 数据库也答不上来不是「吊销」：用 1013（Try Again Later）关闭。circle-im 的
    // src/realtime/client.ts 只把 1008 + 'Session revoked' 当终态，其余一律退避重连，
    // 登录态保留；若这里发撤销帧，一次 Redis+数据库同时抖动会把所有在线用户登出。
    it('closes with a retryable 1013 when the session cannot be verified', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      verifierPrisma.user.findUnique.mockRejectedValue(new Error('db down'));

      await expect(
        authenticate({
          sub: 'user-unverifiable',
          sid: 'session-unverifiable',
          issuedAtMs: Date.now() - 5_000,
        }),
      ).resolves.toEqual({ code: 1013, reason: 'Try again later' });
      expect(realtime.getConnectionCount('user-unverifiable')).toBe(0);
    });
  });
});
