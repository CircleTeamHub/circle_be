import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { Server as IoServer } from 'socket.io';
import { RealtimeGateway } from './realtime.gateway';
import { CHAT_WS_PATH } from 'src/chat/chat.constants';

/**
 * 两个网关共用一个 HTTP server 的升级路由契约。
 *
 * main.ts 先 attach RealtimeGateway(raw ws,/realtime)、后 attach
 * ChatGateway(socket.io,/chat-ws)。`ws` 的 WebSocketServer({server}) 会给
 * http server 挂一个**无条件**的 'upgrade' 监听,路径不匹配就 abortHandshake(400)
 * 把 socket 打死 —— 于是 /chat-ws 的 websocket 升级在 engine.io 看到之前就没了,
 * 客户端(transports:['websocket'])只收到 "websocket error",而 polling 握手正常。
 *
 * 这里用最小装置钉住契约:一个 raw-ws 网关 + 一个 socket.io,两条路径都必须能升级。
 */
describe('websocket upgrade coexistence (/realtime + /chat-ws)', () => {
  let httpServer: Server;
  let gateway: RealtimeGateway;
  let io: IoServer;
  let port: number;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    gateway = new RealtimeGateway(
      { verify: jest.fn() } as never,
      { registerSocket: jest.fn() } as never,
      { isRevoked: jest.fn() } as never,
    );

    httpServer = createServer();
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    );
    port = (httpServer.address() as AddressInfo).port;

    // main.ts 的挂载顺序。
    gateway.attach(httpServer);
    io = new IoServer(httpServer, { path: CHAT_WS_PATH });
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.terminate();
    gateway.onModuleDestroy();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // 每有一条走 /realtime 的升级,engine.io 都会挂一个「不是我的路径」兜底
    // 定时器(固定 1s,没有 unref,socket.io 不透传 destroyUpgradeTimeout),
    // 不等它落地就收工的话,它会跨到下一个 suite 变成「worker 没能优雅退出」。
    await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
  });

  /** 打开一条 ws,返回握手结果(成功 or 失败原因)。 */
  function handshake(
    path: string,
  ): Promise<
    { ok: true; firstMessage: string } | { ok: false; error: string }
  > {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      openSockets.push(socket);
      socket.once('open', () => {
        // engine.io 升级成功后立刻推 OPEN 包(`0{...}`);raw-ws 侧不主动发包,
        // 所以只有 chat 路径会拿到 firstMessage,realtime 靠 'open' 本身判定。
        const timer = setTimeout(
          () => resolve({ ok: true, firstMessage: '' }),
          300,
        );
        socket.once('message', (data) => {
          clearTimeout(timer);
          resolve({ ok: true, firstMessage: data.toString('utf8') });
        });
      });
      socket.once('error', (error: Error) =>
        resolve({ ok: false, error: error.message }),
      );
    });
  }

  it('lets socket.io complete the /chat-ws upgrade', async () => {
    const result = await handshake(
      `${CHAT_WS_PATH}/?EIO=4&transport=websocket`,
    );

    expect(result).toMatchObject({ ok: true });
    // 确认真的是 engine.io 接住了,而不是别的东西把连接放行到空处。
    expect(result.ok && result.firstMessage).toMatch(/^0\{/);
  });

  it('still serves the raw-ws /realtime upgrade', async () => {
    const result = await handshake('/realtime');

    expect(result).toMatchObject({ ok: true });
  });

  it('releases live sockets on destroy so http close can finish', async () => {
    // 已升级的 WebSocket 仍计入 http server 的连接数,close() 会一直等它。
    // SIGTERM/nest --watch 重启都走这条路:卡住的话端口已经不听了,接口全挂。
    const client = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    openSockets.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    gateway.onModuleDestroy();

    const closed = new Promise<'closed'>((resolve) =>
      httpServer.close(() => resolve('closed')),
    );
    const timedOut = new Promise<'hung'>((resolve) =>
      setTimeout(() => resolve('hung'), 2_000),
    );
    await expect(Promise.race([closed, timedOut])).resolves.toBe('closed');
  }, 6_000);

  it('does not leave an unrouted upgrade hanging', async () => {
    // 谁都不认的路径必须被收掉(engine.io 的 destroyUpgrade 兜底),
    // 不能让 socket 永远挂着占资源。
    const socket = new WebSocket(`ws://127.0.0.1:${port}/nobody-serves-this`);
    openSockets.push(socket);

    await expect(
      new Promise<string>((resolve, reject) => {
        // 守护定时器必须清掉,否则它自己会成为 jest 退不出去的那个句柄。
        const guard = setTimeout(
          () => reject(new Error('upgrade left hanging')),
          4_000,
        );
        const settle = (fn: () => void) => {
          clearTimeout(guard);
          fn();
        };
        socket.once('error', (error: Error) =>
          settle(() => resolve(error.message)),
        );
        socket.once('open', () =>
          settle(() => reject(new Error('unexpectedly upgraded'))),
        );
      }),
    ).resolves.toEqual(expect.any(String));
  }, 6_000);
});
