import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import { RealtimeService } from './realtime.service';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CONNECTIONS_PER_USER = 5;
const AUTH_TIMEOUT_MS = 10_000;

type AuthMessage = {
  type: 'auth';
  token: string;
};

type JwtPayload = {
  sub?: unknown;
  exp?: unknown;
};

@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private server: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly userBySocket = new WeakMap<WebSocket, string>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly expiryTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly realtimeService: RealtimeService,
  ) {}

  attach(httpServer: Server) {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({
      server: httpServer,
      path: '/realtime',
    });

    this.server.on('connection', (socket, request) => {
      void this.handleConnection(socket, request);
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

  private async handleConnection(socket: WebSocket, request: IncomingMessage) {
    this.alive.add(socket);

    socket.on('pong', () => {
      this.alive.add(socket);
    });

    // Legacy URL-based auth (kept for backward compatibility — will be removed
    // once all clients are migrated to message-based auth).
    const legacyAuth = this.authenticateFromUrl(request);
    if (legacyAuth) {
      this.logger.warn(
        `Realtime client used deprecated URL-token auth for user ${legacyAuth.userId}`,
      );
      await this.acceptAuthenticatedSocket(socket, legacyAuth.userId, legacyAuth.expMs);
      return;
    }

    // Message-based auth: client must send `{ type: "auth", token }` within window.
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

      void this.acceptAuthenticatedSocket(socket, verified.userId, verified.expMs);
    });

    socket.on('error', (error) => {
      this.logger.warn(
        `Realtime socket error (pre-auth): ${error.message}`,
      );
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
    });
  }

  private async acceptAuthenticatedSocket(
    socket: WebSocket,
    userId: string,
    expMs: number | null,
  ) {
    const currentCount = this.realtimeService.getConnectionCount(userId);
    if (currentCount >= MAX_CONNECTIONS_PER_USER) {
      socket.close(1008, 'Too many connections');
      return;
    }

    this.userBySocket.set(socket, userId);
    this.realtimeService.registerClient(userId, socket);

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

  private authenticateFromUrl(
    request: IncomingMessage,
  ): { userId: string; expMs: number | null } | null {
    const url = new URL(request.url ?? '/', 'ws://localhost');
    const token = url.searchParams.get('token');
    if (!token) return null;
    return this.verifyToken(token);
  }

  private verifyToken(
    token: string,
  ): { userId: string; expMs: number | null } | null {
    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      if (typeof payload?.sub !== 'string') return null;
      const expMs =
        typeof payload.exp === 'number' ? payload.exp * 1000 : null;
      return { userId: payload.sub, expMs };
    } catch {
      return null;
    }
  }
}
