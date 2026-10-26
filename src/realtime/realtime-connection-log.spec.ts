import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { RealtimeGateway } from './realtime.gateway';

/**
 * /realtime 的连接日志：Caddy 给升级请求的 `ws-{uuid}` 串起升级、认证、就绪、
 * 关闭这几行，每种拒绝都带有限的原因；客户端发来的关闭文本、Origin、令牌都不记。
 * 此前这个网关所有拒绝和关闭路径都没有日志，前端上报的连接问题对不上服务端。
 */
const CADDY_ID = 'ws-3f2b8c1e-9d4a-4b7e-8c21-5a6f0e9d1b23';
const TRACE_ID =
  /^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('realtime connection logging', () => {
  let httpServer: Server;
  let gateway: RealtimeGateway;
  let port: number;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;
  const openSockets: WebSocket[] = [];
  const sessions = {
    verifyWithIdentity: jest.fn(),
    verify: jest.fn(),
  };
  const realtime = {
    getConnectionCount: jest.fn().mockReturnValue(0),
    registerPendingClient: jest.fn(),
    promotePendingClient: jest.fn().mockReturnValue(true),
    unregisterClient: jest.fn(),
    emitSnapshot: jest.fn().mockResolvedValue(undefined),
    wasClosedForRevocation: jest.fn().mockReturnValue(false),
  };

  beforeEach(async () => {
    sessions.verifyWithIdentity.mockResolvedValue({
      verdict: 'active',
      identity: null,
    });
    sessions.verify.mockResolvedValue('active');
    realtime.wasClosedForRevocation.mockReturnValue(false);
    gateway = new RealtimeGateway(
      {
        verify: jest.fn((jwt: string) => {
          if (jwt !== 'good') throw new Error('invalid signature');
          return { sub: 'user-1', accountId: 'account-1' };
        }),
      } as never,
      realtime as never,
      sessions as never,
    );
    warn = jest.spyOn(gateway['logger'], 'warn').mockImplementation();
    error = jest.spyOn(gateway['logger'], 'error').mockImplementation();
    log = jest.spyOn(gateway['logger'], 'log').mockImplementation();
    httpServer = createServer();
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    port = (httpServer.address() as AddressInfo).port;
    gateway.attach(httpServer);
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.terminate();
    gateway.onModuleDestroy();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    jest.clearAllMocks();
  });

  function open(headers: Record<string, string> = {}, origin?: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/realtime`, {
      headers,
      origin,
    });
    openSockets.push(socket);
    return socket;
  }

  const opened = (socket: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  const closed = (socket: WebSocket) =>
    new Promise<number>((resolve) =>
      socket.once('close', (code) => resolve(code)),
    );
  /** The server logs its close line on its own 'close', which can trail the client's. */
  const eventually = async (assertion: () => void) => {
    for (let i = 0; ; i += 1) {
      try {
        assertion();
        return;
      } catch (error) {
        if (i >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  const linesOf = (spy: jest.SpyInstance, event: string) =>
    spy.mock.calls
      .map(([line]) => line)
      .filter((line) => line?.event === event);

  it('ties a rejected auth frame to the trace ID Caddy put on the upgrade', async () => {
    const socket = open({ 'x-connection-trace-id': CADDY_ID });
    await opened(socket);
    socket.send('not json');
    expect(await closed(socket)).toBe(1008);

    expect(linesOf(warn, 'realtime_auth_rejected')).toEqual([
      {
        event: 'realtime_auth_rejected',
        stage: 'auth',
        reason: 'invalid_message',
        traceId: CADDY_ID,
      },
    ]);
    await eventually(() =>
      expect(linesOf(log, 'realtime_connection_closed')).toEqual([
        {
          event: 'realtime_connection_closed',
          stage: 'pre_ready',
          reason: 'invalid_message',
          closeCode: 1008,
          traceId: CADDY_ID,
        },
      ]),
    );
  });

  it('never adopts a trace ID that is not one of Caddy’s', async () => {
    const socket = open({ 'x-connection-trace-id': 'chosen-by-the-client' });
    await opened(socket);
    socket.send(JSON.stringify({ type: 'auth', token: 'forged' }));
    await closed(socket);

    const [line] = linesOf(warn, 'realtime_auth_rejected');
    expect(line).toMatchObject({ reason: 'invalid_token' });
    expect(line.traceId).toMatch(TRACE_ID);
    expect(line.traceId).not.toBe('chosen-by-the-client');
  });

  it('logs ready and a peer close under one trace ID for an admitted socket', async () => {
    const socket = open({ 'x-connection-trace-id': CADDY_ID });
    await opened(socket);
    socket.send(JSON.stringify({ type: 'auth', token: 'good' }));
    await eventually(() =>
      expect(linesOf(log, 'realtime_connection_ready')).toEqual([
        {
          event: 'realtime_connection_ready',
          stage: 'ready',
          traceId: CADDY_ID,
        },
      ]),
    );
    socket.close(4001, 'free text from the client');
    await eventually(() =>
      expect(linesOf(log, 'realtime_connection_closed')).toEqual([
        {
          event: 'realtime_connection_closed',
          stage: 'ready',
          reason: 'peer_or_network',
          closeCode: 4001,
          traceId: CADDY_ID,
        },
      ]),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('free text');
  });

  it('labels a close the service made for a revoked session', async () => {
    const socket = open({ 'x-connection-trace-id': CADDY_ID });
    await opened(socket);
    socket.send(JSON.stringify({ type: 'auth', token: 'good' }));
    await eventually(() =>
      expect(linesOf(log, 'realtime_connection_ready')).toHaveLength(1),
    );
    realtime.wasClosedForRevocation.mockReturnValue(true);
    socket.close(1000);
    await eventually(() =>
      expect(linesOf(log, 'realtime_connection_closed')[0]).toMatchObject({
        stage: 'ready',
        reason: 'revoked_while_open',
      }),
    );
  });

  it('logs a revoked session at connect as an auth rejection', async () => {
    sessions.verifyWithIdentity.mockResolvedValue({
      verdict: 'revoked',
      identity: null,
    });
    const socket = open({ 'x-connection-trace-id': CADDY_ID });
    await opened(socket);
    socket.send(JSON.stringify({ type: 'auth', token: 'good' }));
    await closed(socket);
    expect(linesOf(warn, 'realtime_auth_rejected')).toEqual([
      expect.objectContaining({ reason: 'revoked', traceId: CADDY_ID }),
    ]);
  });

  it('always logs a server-side admission failure', async () => {
    sessions.verifyWithIdentity.mockRejectedValue(new Error('database down'));
    for (let i = 0; i < 7; i += 1) {
      const socket = open();
      await opened(socket);
      socket.send(JSON.stringify({ type: 'auth', token: 'good' }));
      expect(await closed(socket)).toBe(1011);
    }
    // 'error' 是服务端故障，客户端触发不了：记 error 级、不采样（会计入
    // BackendErrorLogSpike）。
    expect(
      linesOf(error, 'realtime_auth_rejected').filter(
        (l) => l.reason === 'error',
      ),
    ).toHaveLength(7);
    expect(linesOf(warn, 'realtime_auth_rejected')).toHaveLength(0);
  });

  it('samples client-triggerable rejections and their close lines', async () => {
    for (let i = 0; i < 7; i += 1) {
      const socket = open();
      await opened(socket);
      socket.send('not json');
      await closed(socket);
    }
    // 认证是消息式的：带失效令牌重连的客户端每次都能完成升级再被关掉。拒绝行和
    // 没走到 ready 的关闭行都按原因采样，每分钟最多 5 行；压掉的条数在窗口结束
    // 时补报（见 warn-sampler.spec）。
    expect(linesOf(warn, 'realtime_auth_rejected')).toHaveLength(5);
    await eventually(() =>
      expect(linesOf(log, 'realtime_connection_closed')).toHaveLength(5),
    );
  });

  it('keeps the first reason when a rejected socket is rejected again', () => {
    // 拒绝后对端迟迟不回关闭帧时，认证超时还会再触发一次。
    const socket = { close: jest.fn() };
    gateway['rejectAuth'](
      socket as never,
      'invalid_token',
      1008,
      'Unauthorized',
    );
    gateway['rejectAuth'](
      socket as never,
      'auth_timeout',
      1008,
      'Auth timeout',
    );
    expect(linesOf(warn, 'realtime_auth_rejected')).toEqual([
      expect.objectContaining({ reason: 'invalid_token' }),
    ]);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(gateway['closeReasonBySocket'].get(socket as never)).toBe(
      'invalid_token',
    );
  });

  it('logs an upgrade refused for its origin without the origin itself', async () => {
    const socket = open(
      { 'x-connection-trace-id': CADDY_ID },
      'https://evil.example.test',
    );
    await new Promise<void>((resolve) => socket.once('error', () => resolve()));
    expect(linesOf(warn, 'realtime_connection_rejected')).toEqual([
      {
        event: 'realtime_connection_rejected',
        stage: 'upgrade',
        reason: 'origin_forbidden',
        statusCode: 403,
        traceId: CADDY_ID,
      },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('evil.example.test');
  });
});
