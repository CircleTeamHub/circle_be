import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import type { JwtPayload } from 'src/auth/types';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import {
  SESSION_REVOCATION_CHANNEL,
  parseSessionRevocationBroadcast,
} from 'src/auth/session-revocation.broadcast';
import { RedisService } from 'src/redis/redis.service';
import { ChatErrorCode, type AppErrorCode } from 'src/common/app-error-codes';
import {
  CHAT_EVENTS,
  CHAT_RATE_LIMITS,
  CHAT_WS_PATH,
  conversationRoom,
  userRoom,
} from './chat.constants';
import { SlidingWindowRateLimiter } from './chat-rate-limiter';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatPushService } from './chat-push.service';
import { ChatService } from './chat.service';
import type {
  ChatAckError,
  ChatPresenceQuery,
  ChatReadAck,
  ChatReadPayload,
  ChatSendAck,
  ChatSendPayload,
  ChatTypingPayload,
} from './chat.types';

type CorsOrigin = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) => void;

type AckFn<T> = (response: T) => void;

/** 毫秒级签发时间:优先显式声明,回退 iat;与 RealtimeGateway 同一取法。 */
function issuedAtMsOf(payload: JwtPayload): number | null {
  if (typeof payload.issuedAtMs === 'number') return payload.issuedAtMs;
  if (typeof payload.iat === 'number') return payload.iat * 1000;
  return null;
}

/**
 * 自研聊天网关(squady websocket.gateway 的移植,收窄到 circle 需要的事件面)。
 * 仿 RealtimeGateway 的挂载方式:普通 @Injectable + main.ts 里 attach 到
 * 同一 HTTP server,路径 /chat-ws(/realtime 已被 raw-ws 网关占用)。
 *
 * 鉴权:握手 auth.token 里带 app JWT(不走 URL query,不进访问日志),
 * 验签 + 吊销检查通过才建立连接 —— 复用 app 会话,没有 OpenIM 式双 token。
 */
@Injectable()
export class ChatGateway {
  private readonly logger = new Logger(ChatGateway.name);
  private io: Server | null = null;

  private readonly sendLimiter = new SlidingWindowRateLimiter(
    CHAT_RATE_LIMITS.send.limit,
    CHAT_RATE_LIMITS.send.windowMs,
  );
  private readonly readLimiter = new SlidingWindowRateLimiter(
    CHAT_RATE_LIMITS.read.limit,
    CHAT_RATE_LIMITS.read.windowMs,
  );
  private readonly typingLimiter = new SlidingWindowRateLimiter(
    CHAT_RATE_LIMITS.typing.limit,
    CHAT_RATE_LIMITS.typing.windowMs,
  );
  private readonly presenceLimiter = new SlidingWindowRateLimiter(
    CHAT_RATE_LIMITS.presence.limit,
    CHAT_RATE_LIMITS.presence.windowMs,
  );

  constructor(
    private readonly jwtService: JwtService,
    private readonly sessionRevocation: SessionRevocationService,
    private readonly chatService: ChatService,
    private readonly broadcast: ChatBroadcastService,
    private readonly chatPush: ChatPushService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  attach(httpServer: HttpServer, options: { corsOrigin: CorsOrigin }): void {
    const io = new Server(httpServer, {
      path: CHAT_WS_PATH,
      cors: { origin: options.corsOrigin, credentials: true },
      // 单条 socket 报文上限,与 content 8KB 上限同数量级留余量。
      maxHttpBufferSize: 64 * 1024,
    });

    io.use((socket, next) => {
      void this.authenticate(socket)
        .then((userId) => {
          if (!userId) {
            next(new Error('unauthorized'));
            return;
          }
          socket.data.userId = userId;
          next();
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `handshake auth errored: ${error instanceof Error ? error.message : String(error)}`,
          );
          next(new Error('unauthorized'));
        });
    });

    io.on('connection', (socket) => {
      void this.handleConnection(socket);
    });

    this.io = io;
    this.broadcast.setServer(io);
    // 封禁/登出吊销 → 踢掉在线 chat socket(否则旧连接可继续收发到自然断开)。
    void this.redisService
      .subscribePattern(SESSION_REVOCATION_CHANNEL, (_channel, message) => {
        void this.handleRevocation(message);
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `revocation subscribe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.logger.log(`chat gateway attached at ${CHAT_WS_PATH}`);
  }

  /**
   * 握手鉴权:仅接受 access token(sub + accountId 均为 string),
   * 与 RealtimeGateway.verifyToken 同一判定;再过一次吊销检查。
   */
  private async authenticate(socket: Socket): Promise<string | null> {
    const token = (socket.handshake.auth as Record<string, unknown> | undefined)
      ?.token;
    if (typeof token !== 'string' || token.length === 0) return null;
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token);
    } catch {
      return null;
    }
    if (typeof payload?.sub !== 'string') return null;
    if (typeof payload?.accountId !== 'string') return null;
    if (await this.sessionRevocation.isRevoked(payload)) return null;
    socket.data.sessionId =
      typeof payload.sid === 'string' ? payload.sid : null;
    socket.data.issuedAtMs = issuedAtMsOf(payload);
    return payload.sub;
  }

  /** 与 RealtimeGateway 同源的吊销语义:user 级按签发时间比对,session 级按 sid。 */
  private async handleRevocation(message: string): Promise<void> {
    const io = this.io;
    if (!io) return;
    const broadcast = parseSessionRevocationBroadcast(message);
    if (!broadcast) return;
    const sockets =
      broadcast.kind === 'user'
        ? await io.in(userRoom(broadcast.userId)).fetchSockets()
        : await io.fetchSockets();
    for (const socket of sockets) {
      const data = socket.data as {
        sessionId?: string | null;
        issuedAtMs?: number | null;
      };
      const dead =
        broadcast.kind === 'user'
          ? data.issuedAtMs == null || data.issuedAtMs <= broadcast.revokedAtMs
          : data.sessionId === broadcast.sessionId;
      if (dead) socket.disconnect(true);
    }
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const userId = socket.data.userId as string;
    const guestConversationId =
      typeof socket.data.guestConversationId === 'string'
        ? socket.data.guestConversationId
        : null;
    let conversationIds: string[];
    try {
      conversationIds = guestConversationId
        ? [guestConversationId]
        : await this.chatService.listConversationIds(userId);
      await socket.join(userRoom(userId));
      await socket.join(conversationIds.map(conversationRoom));
    } catch (error) {
      // 房间加入失败的连接是"在线但收不到任何推送"的哑连接,直接断开让客户端重连。
      this.logger.error(
        `join rooms failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      socket.disconnect(true);
      return;
    }

    socket.on(
      CHAT_EVENTS.send,
      (payload: ChatSendPayload, ack?: AckFn<ChatSendAck>) => {
        void this.handleSend(socket, userId, payload, ack);
      },
    );
    socket.on(
      CHAT_EVENTS.read,
      (payload: ChatReadPayload, ack?: AckFn<ChatReadAck>) => {
        void this.handleRead(socket, userId, payload, ack);
      },
    );
    socket.on(CHAT_EVENTS.typing, (payload: ChatTypingPayload) => {
      void this.handleTyping(socket, userId, payload);
    });
    socket.on(
      CHAT_EVENTS.presence,
      (payload: ChatPresenceQuery, ack?: AckFn<Record<string, boolean>>) => {
        void this.handlePresenceQuery(socket, payload, ack);
      },
    );
    socket.on('disconnect', () => {
      this.sendLimiter.clear(socket.id);
      this.readLimiter.clear(socket.id);
      this.typingLimiter.clear(socket.id);
      this.presenceLimiter.clear(socket.id);
      // 末个 socket 断开 = 用户下线,广播到其会话房(尽力而为)。
      void this.broadcast.isUserOnline(userId).then((online) => {
        if (online) return;
        this.broadcast.emitPresence(conversationIds, { userId, online: false });
      });
    });

    // 上线广播到其会话房(多设备重复连入时会重复广播 online=true,幂等无害)。
    this.broadcast.emitPresence(conversationIds, { userId, online: true });
  }

  /** 在线状态查询:一次最多 50 个 userId,ack 回 {userId: online}。 */
  private async handlePresenceQuery(
    socket: Socket,
    payload: ChatPresenceQuery,
    ack?: AckFn<Record<string, boolean>>,
  ): Promise<void> {
    if (typeof ack !== 'function') return;
    if (!this.presenceLimiter.tryAcquire(socket.id)) {
      ack({});
      return;
    }
    const userIds = Array.isArray(payload?.userIds)
      ? payload.userIds.filter((id) => typeof id === 'string').slice(0, 50)
      : [];
    const entries = await Promise.all(
      userIds.map(
        async (id) => [id, await this.broadcast.isUserOnline(id)] as const,
      ),
    );
    ack(Object.fromEntries(entries));
  }

  private async handleSend(
    socket: Socket,
    userId: string,
    payload: ChatSendPayload,
    ack?: AckFn<ChatSendAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    if (!this.sendLimiter.tryAcquire(socket.id)) {
      reply(this.ackError(ChatErrorCode.RateLimited, '发送太频繁'));
      return;
    }
    try {
      const result = await this.chatService.sendMessage(userId, payload);
      reply({
        ok: true,
        messageId: result.message.id,
        height: result.message.height,
        d: result.message.d ?? payload.d,
      });
      // 幂等复用(断线重发撞库)不再广播,首次投递时房间里已经收到过了。
      if (!result.reused) {
        this.broadcast.emitMessage(result.message);
        // 离线成员推送:best-effort,不阻塞发送方 ack 路径。
        void this.chatPush.onMessageBroadcast(result.message);
      }
    } catch (error) {
      reply(this.toAckError(error, 'send', userId, payload?.conversationId));
    }
  }

  private async handleRead(
    socket: Socket,
    userId: string,
    payload: ChatReadPayload,
    ack?: AckFn<ChatReadAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    if (!this.readLimiter.tryAcquire(socket.id)) {
      reply(this.ackError(ChatErrorCode.RateLimited));
      return;
    }
    try {
      const conversationId = payload?.conversationId;
      const height = Number(payload?.height);
      const advanced = await this.chatService.markRead(
        userId,
        conversationId,
        height,
      );
      reply({ ok: true });
      if (advanced) {
        this.broadcast.emitRead({ conversationId, userId, height });
      }
    } catch (error) {
      reply(this.toAckError(error, 'read', userId, payload?.conversationId));
    }
  }

  private async handleTyping(
    socket: Socket,
    userId: string,
    payload: ChatTypingPayload,
  ): Promise<void> {
    if (!this.typingLimiter.tryAcquire(socket.id)) return;
    const conversationId = payload?.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0)
      return;
    // typing 是尽力而为的提示,不做成员查询放大;但只对本人已在的房间转发,
    // socket.rooms 本身就是服务端派生的成员关系,非成员房不会命中。
    if (!socket.rooms.has(conversationRoom(conversationId))) return;
    this.broadcast.emitTyping({ conversationId, userId }, socket.id);
  }

  /** ack 只回一次;缺省 ack(异常客户端)则丢弃,不让回调报错毁掉事件循环。 */
  private ackOnce<T>(ack?: AckFn<T>): AckFn<T> {
    let done = false;
    return (response: T) => {
      if (done || typeof ack !== 'function') return;
      done = true;
      try {
        ack(response);
      } catch (error) {
        this.logger.warn(
          `ack callback threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
  }

  private ackError(code: AppErrorCode, message?: string): ChatAckError {
    return { ok: false, code, ...(message ? { message } : {}) };
  }

  /**
   * 服务层的 Nest 异常({message, errorCode})→ socket ack。
   * REST 与 socket 共用同一套错误码,前端 serverErrors 词表一次覆盖两个面。
   */
  private toAckError(
    error: unknown,
    action: string,
    userId: string,
    conversationId?: string,
  ): ChatAckError {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (
        typeof response === 'object' &&
        response !== null &&
        'errorCode' in response
      ) {
        const { errorCode, message } = response as {
          errorCode: AppErrorCode;
          message?: string;
        };
        return this.ackError(errorCode, message);
      }
    }
    this.logger.error(
      `chat ${action} failed user=${userId} conversation=${conversationId ?? '-'}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return this.ackError(ChatErrorCode.InvalidPayload, '请求失败');
  }
}
