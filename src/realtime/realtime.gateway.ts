import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { RealtimeService } from './realtime.service';

@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private server: WebSocketServer | null = null;
  private readonly userBySocket = new WeakMap<WebSocket, string>();

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
  }

  onModuleDestroy() {
    this.server?.close();
    this.server = null;
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage) {
    const userId = this.authenticate(request);

    if (!userId) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    this.userBySocket.set(socket, userId);
    this.realtimeService.registerClient(userId, socket);
    await this.realtimeService.emitSnapshot(userId);

    socket.on('close', () => {
      const currentUserId = this.userBySocket.get(socket);
      if (currentUserId) {
        this.realtimeService.unregisterClient(currentUserId, socket);
      }
    });

    socket.on('error', (error) => {
      this.logger.warn(`Realtime socket error for ${userId}: ${error.message}`);
    });
  }

  private authenticate(request: IncomingMessage) {
    const url = new URL(request.url ?? '/', 'ws://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      return null;
    }

    try {
      const payload = this.jwtService.verify(token);
      return typeof payload?.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
