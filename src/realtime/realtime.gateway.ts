import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import {
  REVOKED_CLOSE_CODE,
  REVOKED_CLOSE_REASON,
  RealtimeService,
  type RealtimeSocketIdentity,
} from './realtime.service';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CONNECTIONS_PER_USER = 5;
const AUTH_TIMEOUT_MS = 10_000;
const REALTIME_PATH = '/realtime';

/** 与 ws 的 shouldHandle 同一套取法:只切掉 query,不做任何归一化。 */
function pathnameOf(url: string | undefined): string {
  if (!url) return '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

type AuthMessage = {
  type: 'auth';
  token: string;
};

type JwtPayload = {
  sub?: unknown;
  accountId?: unknown;
  exp?: unknown;
  sid?: unknown;
  iat?: unknown;
  issuedAtMs?: unknown;
};

type VerifiedToken = {
  userId: string;
  expMs: number | null;
  identity: RealtimeSocketIdentity;
  /** Retained so the connect-time revocation check sees the same claims HTTP does. */
  payload: JwtPayload;
};

@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private server: WebSocketServer | null = null;
  /** noServer 模式下自己挂/自己摘 'upgrade' 监听,两个引用都要留着。 */
  private httpServer: Server | null = null;
  private upgradeHandler: UpgradeHandler | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly userBySocket = new WeakMap<WebSocket, string>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly expiryTimers = new WeakMap<
    WebSocket,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly jwtService: JwtService,
    private readonly realtimeService: RealtimeService,
    private readonly revocation: SessionRevocationService,
  ) {}

  attach(httpServer: Server) {
    if (this.server) {
      return;
    }

    // `noServer` + 自己路由,而不是 `{ server, path }`。
    //
    // WebSocketServer({ server }) 会给 http server 挂一个**无条件**的 'upgrade'
    // 监听:路径不匹配就 abortHandshake(socket, 400) 把连接打死。同一个 HTTP
    // server 上还挂着 socket.io(/chat-ws),它的 websocket 升级于是在 engine.io
    // 看到之前就被这里 400 掉 —— 客户端只看到 "websocket error",而 polling
    // 握手一切正常(polling 走的是 'request',engine.io attach 时已经接管)。
    // engine.io 自己是共存友好的(路径不认就让给别的监听器),所以只要这一侧
    // 不越权处理别人的路径,两个网关就能各走各的。
    this.server = new WebSocketServer({
      noServer: true,
      // Clients only ever send a small `{ type: "auth", token }` frame; cap
      // the payload so an oversized frame cannot exhaust memory pre-auth.
      maxPayload: 16 * 1024,
    });

    const wss = this.server;
    this.upgradeHandler = (req, socket, head) => {
      if (pathnameOf(req.url) !== REALTIME_PATH) {
        // 不是我们的路径:什么都不做,交给同一个 server 上的其它 'upgrade' 监听。
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        wss.emit('connection', client, req);
      });
    };
    this.httpServer = httpServer;
    httpServer.on('upgrade', this.upgradeHandler);

    this.server.on('connection', (socket) => {
      void this.handleConnection(socket);
    });

    this.heartbeatTimer = setInterval(() => {
      this.server?.clients.forEach((socket) => {
        if (!this.alive.has(socket)) {
          socket.terminate();
          return;
        }
        this.alive.delete(socket);
        socket.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // `noServer` 模式下 ws 不认识这个 http server,监听器得自己摘 ——
    // 留着的话销毁后的实例还会继续接升级请求(测试之间、热重载都会串)。
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off('upgrade', this.upgradeHandler);
    }
    this.httpServer = null;
    this.upgradeHandler = null;
    // 已经升级成 WebSocket 的连接仍然计在 http server 的连接数里,而
    // wss.close() 不动它们 —— 只要还有一个客户端连着,app.close() 就一直
    // pending:nest --watch 的重启和生产 SIGTERM 都会停在这一步(端口已经
    // 不监听了,所有接口一起挂),直到编排器 SIGKILL 把清理和日志 flush 全跳过。
    // ChatGateway 早有这个钩子(io.close() 自带断连),realtime 侧漏了。
    // 用 terminate 而不是 close:close 要等对端回 close 帧,对端不回就再挂 30s,
    // 关停必须是确定性的;客户端本来就按断线重连处理。
    for (const client of this.server?.clients ?? []) {
      client.terminate();
    }
    this.server?.close();
    this.server = null;
  }

  private async handleConnection(socket: WebSocket) {
    this.alive.add(socket);

    socket.on('pong', () => {
      this.alive.add(socket);
    });

    // Message-based auth only: client must send `{ type: "auth", token }`
    // within the auth window. URL-token auth was removed because a JWT placed
    // in the upgrade URL leaks into proxy/access logs and `Referer` headers.
    const authTimeout = setTimeout(() => {
      socket.close(1008, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    socket.once('message', (data: RawData) => {
      const auth = this.parseAuthMessage(data);
      if (!auth) {
        socket.close(1008, 'Invalid auth message');
        return;
      }

      const verified = this.verifyToken(auth.token);
      if (!verified) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      void this.acceptAuthenticatedSocket(socket, verified, authTimeout).catch(
        (error: unknown) => {
          reportOperationalError(error, {
            component: 'RealtimeGateway',
            operation: 'admitSocket',
            kind: 'websocket',
          });
          this.logger.error('Realtime socket admission failed');
          socket.close(1011, 'Internal error');
        },
      );
    });

    socket.on('error', (error) => {
      this.logger.warn(`Realtime socket error (pre-auth): ${error.message}`);
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
    });
  }

  private async acceptAuthenticatedSocket(
    socket: WebSocket,
    verified: VerifiedToken,
    authTimeout: ReturnType<typeof setTimeout>,
  ) {
    const { userId, expMs, identity } = verified;

    this.userBySocket.set(socket, userId);
    // Install teardown before any await or registration. A client can disappear
    // during either marker lookup; cleanup must cover both pending and active
    // state so no connection slot is stranded.
    socket.on('close', () => {
      clearTimeout(authTimeout);
      const timer = this.expiryTimers.get(socket);
      if (timer) {
        clearTimeout(timer);
        this.expiryTimers.delete(socket);
      }
      const currentUserId = this.userBySocket.get(socket);
      if (currentUserId) {
        this.realtimeService.unregisterClient(currentUserId, socket);
      }
    });

    // Same check the HTTP strategy runs (F-02), so a banned or logged-out token
    // cannot open a new stream. Fail-open exactly like HTTP: with Redis off this
    // resolves false rather than locking every user out of realtime.
    if (await this.revocation.isRevoked(verified.payload)) {
      socket.close(REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON);
      return;
    }

    // The revocation lookup above is the first `await` between authenticating
    // and registering, so the client may have vanished meanwhile. Registering a
    // dead socket would strand it in the client map — its `close` already fired,
    // and the unregister listener is only attached below — burning one of the
    // user's connection slots permanently.
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const currentCount = this.realtimeService.getConnectionCount(userId);
    if (currentCount >= MAX_CONNECTIONS_PER_USER) {
      socket.close(1008, 'Too many connections');
      return;
    }

    this.realtimeService.registerPendingClient(userId, socket, identity);

    socket.on('error', (error) => {
      this.logger.warn(`Realtime socket error for ${userId}: ${error.message}`);
    });

    if (expMs !== null) {
      const ttl = expMs - Date.now();
      if (ttl <= 0) {
        socket.close(1008, 'Token expired');
        return;
      }
      const timer = setTimeout(() => {
        socket.close(1008, 'Token expired');
      }, ttl);
      this.expiryTimers.set(socket, timer);
    }

    // Close the check/register gap. Pending registration lets revocation
    // broadcasts find and close the socket while keeping it out of business
    // event delivery until this final marker check succeeds.
    //
    // If a revocation was published after the
    // first Redis GET observed "not revoked" but before this socket entered the
    // local map, that broadcast could not find it. Once registered, check the
    // marker again: earlier revocations are caught here, later ones find the
    // registered socket through pub/sub.
    if (await this.revocation.isRevoked(verified.payload)) {
      socket.close(REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON);
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this.realtimeService.promotePendingClient(userId, socket)) {
      return;
    }
    clearTimeout(authTimeout);

    try {
      await this.realtimeService.emitSnapshot(userId);
    } catch (error) {
      reportOperationalError(error, {
        component: 'RealtimeGateway',
        operation: 'emitSnapshot',
        kind: 'websocket',
      });
      this.logger.warn(
        `Failed to emit initial snapshot for ${userId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private parseAuthMessage(data: RawData): AuthMessage | null {
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as AuthMessage).type === 'auth' &&
        typeof (parsed as AuthMessage).token === 'string' &&
        (parsed as AuthMessage).token.length > 0
      ) {
        return parsed as AuthMessage;
      }
      return null;
    } catch {
      return null;
    }
  }

  private verifyToken(token: string): VerifiedToken | null {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      // Only an access token is accepted: it always carries both `sub` and
      // `accountId`. Refresh tokens are opaque random strings (not JWTs), so
      // they cannot reach here — this also rejects any other token shape.
      if (typeof payload?.sub !== 'string') return null;
      if (typeof payload?.accountId !== 'string') return null;
      const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
      return {
        userId: payload.sub,
        expMs,
        identity: {
          sessionId: typeof payload.sid === 'string' ? payload.sid : null,
          issuedAtMs: issuedAtMs(payload),
        },
        payload,
      };
    } catch {
      return null;
    }
  }
}

/** Millisecond issuance time, preferring the explicit claim over `iat`. */
function issuedAtMs(payload: JwtPayload): number | null {
  if (typeof payload.issuedAtMs === 'number') return payload.issuedAtMs;
  if (typeof payload.iat === 'number') return payload.iat * 1000;
  return null;
}
