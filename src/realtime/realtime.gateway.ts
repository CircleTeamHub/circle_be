import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  SessionVerifier,
  type SessionVerdict,
} from 'src/auth/session-verifier.service';
import {
  REVOKED_CLOSE_CODE,
  REVOKED_CLOSE_REASON,
  RealtimeService,
  type RealtimeSocketIdentity,
} from './realtime.service';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { sanitizeLogValue } from 'src/logging/log-sanitizer';
import {
  CONNECTION_TRACE_HEADER,
  resolveConnectionTraceId,
} from 'src/logging/connection-trace-id';
import { WarnSampler } from 'src/logging/warn-sampler';

import { resolveCorsOriginChecker } from 'src/config/cors-origin';
import { SocketAdmission } from './socket-admission';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CONNECTIONS_PER_USER = 5;
const AUTH_TIMEOUT_MS = 10_000;
const REALTIME_PATH = '/realtime';
/**
 * RFC 6455 "Try Again Later". Sent when neither Redis nor the database can say
 * whether the token was revoked. The app client (circle-im src/realtime/client.ts)
 * treats only 1008 + 'Session revoked' as terminal and reconnects with backoff
 * on anything else, so the session survives a joint Redis + database outage.
 */
const UNVERIFIABLE_CLOSE_CODE = 1013;
const UNVERIFIABLE_CLOSE_REASON = 'Try again later';

/**
 * Why a connection never got past the upgrade, or was closed. Fixed values
 * only: log lines carry these and the trace ID, never the close text a client
 * sent, its origin, or its token.
 */
type RealtimeUpgradeRejection =
  | 'origin_forbidden'
  | 'capacity'
  | 'admission_full';
type RealtimeAuthRejection =
  | 'auth_timeout'
  | 'invalid_message'
  | 'invalid_token'
  | 'revoked'
  | 'session_unverifiable'
  | 'too_many_connections'
  | 'token_expired'
  | 'error';
type RealtimeCloseReason =
  | RealtimeAuthRejection
  | 'token_expired_while_open'
  | 'revoked_while_open'
  | 'heartbeat_timeout'
  | 'shutdown';

/** Client-triggerable rejections log at most this many lines per reason per window. */
const REJECTION_WARN_PER_WINDOW = 5;
const REJECTION_WARN_WINDOW_MS = 60_000;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Behind Caddy this is its `ws-{uuid}` for the upgrade request (Caddyfile.admin). */
function upgradeTraceId(req: IncomingMessage): string {
  return resolveConnectionTraceId(
    firstHeader(req.headers[CONNECTION_TRACE_HEADER]),
  );
}

/** RFC 6455 codes are 1000-4999; anything else from a peer is not logged. */
function boundedCloseCode(code: unknown): number | undefined {
  return typeof code === 'number' &&
    Number.isInteger(code) &&
    code >= 1000 &&
    code <= 4999
    ? code
    : undefined;
}

function safeSystemErrorCode(error: unknown): string | undefined {
  const code =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value
      : undefined;
  return typeof code === 'string' && /^E[A-Z0-9_]{1,31}$/.test(code)
    ? code
    : undefined;
}

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
  private readonly admission = new SocketAdmission(
    2000,
    128,
    10_000,
    'realtime',
  );
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
  /** Correlates the upgrade, auth, ready and close lines of one connection. */
  private readonly traceBySocket = new WeakMap<WebSocket, string>();
  /** Set right before the server closes a socket, so the close line says why. */
  private readonly closeReasonBySocket = new WeakMap<
    WebSocket,
    RealtimeCloseReason
  >();
  private readonly readySockets = new WeakSet<WebSocket>();
  private readonly rejectionSampler = new WarnSampler(
    REJECTION_WARN_PER_WINDOW,
    REJECTION_WARN_WINDOW_MS,
  );

  constructor(
    private readonly jwtService: JwtService,
    private readonly realtimeService: RealtimeService,
    private readonly sessions: SessionVerifier,
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
      const traceId = upgradeTraceId(req);
      const origin = req.headers.origin;
      resolveCorsOriginChecker()(origin, (error, allowed) => {
        if (socket.destroyed) return;
        if (error || !allowed) {
          this.logUpgradeRejected('origin_forbidden', 403, traceId);
          socket.end(
            'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          );
          return;
        }
        if (!this.admission.hasCapacity()) {
          this.logUpgradeRejected('capacity', 503, traceId);
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          );
          return;
        }
        wss.handleUpgrade(req, socket, head, (client) => {
          if (!this.admission.acquire(client, () => client.terminate())) {
            this.logUpgradeRejected('admission_full', undefined, traceId);
            client.terminate();
            return;
          }
          this.traceBySocket.set(client, traceId);
          client.once('close', () => this.admission.release(client));
          wss.emit('connection', client, req);
        });
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
          this.markClosing(socket, 'heartbeat_timeout');
          socket.terminate();
          return;
        }
        this.alive.delete(socket);
        socket.ping();
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  onModuleDestroy() {
    this.admission.destroy();
    this.rejectionSampler.dispose();
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
      this.markClosing(client, 'shutdown');
      client.terminate();
    }
    this.server?.close();
    this.server = null;
  }

  private async handleConnection(socket: WebSocket) {
    this.alive.add(socket);
    const traceId = this.traceIdOf(socket);

    socket.on('pong', () => {
      this.alive.add(socket);
    });

    // Message-based auth only: client must send `{ type: "auth", token }`
    // within the auth window. URL-token auth was removed because a JWT placed
    // in the upgrade URL leaks into proxy/access logs and `Referer` headers.
    const authTimeout = setTimeout(() => {
      this.rejectAuth(socket, 'auth_timeout', 1008, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    socket.once('message', (data: RawData) => {
      const auth = this.parseAuthMessage(data);
      if (!auth) {
        this.rejectAuth(
          socket,
          'invalid_message',
          1008,
          'Invalid auth message',
        );
        return;
      }

      const verified = this.verifyToken(auth.token);
      if (!verified) {
        this.rejectAuth(socket, 'invalid_token', 1008, 'Unauthorized');
        return;
      }

      void this.acceptAuthenticatedSocket(socket, verified, authTimeout).catch(
        (error: unknown) => {
          reportOperationalError(error, {
            component: 'RealtimeGateway',
            operation: 'admitSocket',
            kind: 'websocket',
          });
          this.rejectAuth(socket, 'error', 1011, 'Internal error');
        },
      );
    });

    socket.on('error', (error) => {
      this.logger.warn(
        sanitizeLogValue({
          event: 'realtime_socket_error',
          operation: 'handleConnection',
          errorCode: safeSystemErrorCode(error),
          error,
          traceId,
        }),
      );
    });

    socket.on('close', (code: number) => {
      clearTimeout(authTimeout);
      // 与 chat 网关的 ws_connection_closed 对齐：stage 区分「接纳成功后断开」和
      // 「没走到 ready 就被拒/断了」，否则接纳成功率会被算高。对端发来的关闭文本
      // 是客户端可控的，不记。
      const stage = this.readySockets.has(socket) ? 'ready' : 'pre_ready';
      const reason =
        this.closeReasonBySocket.get(socket) ??
        (this.realtimeService.wasClosedForRevocation(socket)
          ? 'revoked_while_open'
          : 'peer_or_network');
      // 认证是消息式的：带着失效令牌重连的客户端每次都能完成升级，再被关掉。
      // 这一类按原因采样（与拒绝那一行同一个预算），否则重连风暴照样刷满日志
      // 配额；走到 ready 的连接每条都记。
      if (
        stage === 'pre_ready' &&
        !this.rejectionSampler.admit(`close:${reason}`, (count) =>
          this.logger.log({
            event: 'realtime_connection_closed_suppressed',
            stage,
            reason,
            suppressed: count,
            windowMs: this.rejectionSampler.windowMs,
          }),
        )
      ) {
        return;
      }
      this.logger.log({
        event: 'realtime_connection_closed',
        stage,
        reason,
        closeCode: boundedCloseCode(code),
        traceId,
      });
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

    // Same verdict the HTTP strategy reaches (F-02, via SessionVerifier), so a
    // banned or logged-out token cannot open a new stream — including when Redis
    // is off, where the verifier consults the database instead of failing open.
    const admission = await this.sessions.verifyWithIdentity(verified.payload);
    if (admission.verdict !== 'active') {
      this.closeUnverifiedSocket(socket, admission.verdict);
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
      this.rejectAuth(
        socket,
        'too_many_connections',
        1008,
        'Too many connections',
      );
      return;
    }

    this.realtimeService.registerPendingClient(
      userId,
      socket,
      admission.identity ?? identity,
    );

    socket.on('error', (error) => {
      this.logger.warn(
        sanitizeLogValue({
          event: 'realtime_socket_error',
          operation: 'acceptAuthenticatedSocket',
          userId,
          errorCode: safeSystemErrorCode(error),
          error,
          traceId: this.traceIdOf(socket),
        }),
      );
    });

    if (expMs !== null) {
      const ttl = expMs - Date.now();
      if (ttl <= 0) {
        this.rejectAuth(socket, 'token_expired', 1008, 'Token expired');
        return;
      }
      const timer = setTimeout(() => {
        // 正常的会话到期，不是拒绝：只在关闭那一行里记原因。
        this.markClosing(socket, 'token_expired_while_open');
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
    const finalVerdict = await this.sessions.verify(verified.payload);
    if (finalVerdict !== 'active') {
      this.closeUnverifiedSocket(socket, finalVerdict);
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!this.realtimeService.promotePendingClient(userId, socket)) {
      return;
    }
    clearTimeout(authTimeout);
    this.admission.authenticate(socket);
    this.readySockets.add(socket);
    this.logger.log({
      event: 'realtime_connection_ready',
      stage: 'ready',
      traceId: this.traceIdOf(socket),
    });

    try {
      await this.realtimeService.emitSnapshot(userId);
    } catch (error) {
      reportOperationalError(error, {
        component: 'RealtimeGateway',
        operation: 'emitSnapshot',
        kind: 'websocket',
      });
      this.logger.warn(
        sanitizeLogValue({
          event: 'realtime_snapshot_failed',
          operation: 'emitSnapshot',
          userId,
          error,
          traceId: this.traceIdOf(socket),
        }),
      );
    }
  }

  /** Revoked sessions get the terminal frame; an unverifiable one a retryable close. */
  private closeUnverifiedSocket(
    socket: WebSocket,
    verdict: Exclude<SessionVerdict, 'active'>,
  ): void {
    if (verdict === 'revoked') {
      this.rejectAuth(
        socket,
        'revoked',
        REVOKED_CLOSE_CODE,
        REVOKED_CLOSE_REASON,
      );
      return;
    }
    this.rejectAuth(
      socket,
      'session_unverifiable',
      UNVERIFIABLE_CLOSE_CODE,
      UNVERIFIABLE_CLOSE_REASON,
    );
  }

  private traceIdOf(socket: WebSocket): string {
    let traceId = this.traceBySocket.get(socket);
    if (!traceId) {
      traceId = resolveConnectionTraceId(undefined);
      this.traceBySocket.set(socket, traceId);
    }
    return traceId;
  }

  /**
   * Logs why the connection is refused, then closes it. 'error' is a server
   * fault a client cannot trigger: logged at error level and never sampled.
   * The rest are client-triggerable warnings and are sampled.
   */
  private rejectAuth(
    socket: WebSocket,
    reason: RealtimeAuthRejection,
    code: number,
    text: string,
  ): void {
    // 第一个原因为准：拒绝后对端迟迟不回关闭帧时，认证超时还会再触发一次，
    // 不能把真正的原因改写成 auth_timeout、也不能多记一行。
    if (!this.markClosing(socket, reason)) return;
    const traceId = this.traceIdOf(socket);
    const line = {
      event: 'realtime_auth_rejected',
      stage: 'auth',
      reason,
      traceId,
    };
    if (reason === 'error') {
      this.logger.error(line);
    } else if (
      this.rejectionSampler.admit(`auth:${reason}`, (count) =>
        this.logSuppressed(
          'realtime_auth_rejected_suppressed',
          'auth',
          reason,
          count,
        ),
      )
    ) {
      this.logger.warn(line);
    }
    socket.close(code, text);
  }

  private logUpgradeRejected(
    reason: RealtimeUpgradeRejection,
    statusCode: number | undefined,
    traceId: string,
  ): void {
    if (
      this.rejectionSampler.admit(`upgrade:${reason}`, (count) =>
        this.logSuppressed(
          'realtime_connection_rejected_suppressed',
          'upgrade',
          reason,
          count,
        ),
      )
    ) {
      this.logger.warn({
        event: 'realtime_connection_rejected',
        stage: 'upgrade',
        reason,
        statusCode,
        traceId,
      });
    }
  }

  /** Records why the server is closing `socket`; false if a reason is already set. */
  private markClosing(socket: WebSocket, reason: RealtimeCloseReason): boolean {
    if (this.closeReasonBySocket.has(socket)) return false;
    this.closeReasonBySocket.set(socket, reason);
    return true;
  }

  private logSuppressed(
    event: string,
    stage: string,
    reason: string,
    suppressed: number,
  ): void {
    this.logger.warn({
      event,
      stage,
      reason,
      suppressed,
      windowMs: this.rejectionSampler.windowMs,
    });
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
          familyId: null,
          audience: null,
          deviceKey: null,
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
