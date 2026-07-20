import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import {
  REVOKED_CLOSE_CODE,
  REVOKED_CLOSE_REASON,
  RealtimeService,
  type RealtimeSocketIdentity,
} from './realtime.service';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CONNECTIONS_PER_USER = 5;
const AUTH_TIMEOUT_MS = 10_000;

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

    this.server = new WebSocketServer({
      server: httpServer,
      path: '/realtime',
      // Clients only ever send a small `{ type: "auth", token }` frame; cap
      // the payload so an oversized frame cannot exhaust memory pre-auth.
      maxPayload: 16 * 1024,
    });

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
      clearTimeout(authTimeout);

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

      void this.acceptAuthenticatedSocket(socket, verified);
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
  ) {
    const { userId, expMs, identity } = verified;

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

    this.userBySocket.set(socket, userId);
    this.realtimeService.registerClient(userId, socket, identity);

    // Attach teardown before any later branch can close or await. In particular,
    // a token may expire while the revocation lookup is in flight; closing it
    // before this listener exists would strand the socket in the client map.
    socket.on('close', () => {
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

    // Close the check/register gap. If a revocation was published after the
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

    try {
      await this.realtimeService.emitSnapshot(userId);
    } catch (error) {
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
