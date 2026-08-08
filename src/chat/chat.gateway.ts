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
  TEMP_CHAT_GUEST_TOKEN_KIND,
  conversationRoom,
  userRoom,
} from './chat.constants';
import { SlidingWindowRateLimiter } from './chat-rate-limiter';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatPushService } from './chat-push.service';
import { ChatService } from './chat.service';
import type {
  ChatAckError,
  GuestChatTokenPayload,
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
   * 握手鉴权,两种形态共用 auth.token:
   * - app access token(sub + accountId 均为 string),与 RealtimeGateway.verifyToken
   *   同一判定,再过一次吊销检查;
   * - 临时房访客 chatToken(kind=temp-chat-guest,秘钥 TEMP_CHAT_LINK_SECRET)。
   *
   * 先用「未验签的 kind 声明」分流:分流只决定用哪把钥匙验签,伪造 kind
   * 只会被另一把钥匙拒掉,不构成绕过。
   */
  private async authenticate(socket: Socket): Promise<string | null> {
    const token = (socket.handshake.auth as Record<string, unknown> | undefined)
      ?.token;
    if (typeof token !== 'string' || token.length === 0) return null;
    if (this.claimsGuestKind(token)) {
      return this.authenticateGuest(socket, token);
    }
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

  /** 不验签地读一下 kind,仅用于分流到对应的验签分支。 */
  private claimsGuestKind(token: string): boolean {
    try {
      const decoded: unknown = this.jwtService.decode(token);
      return (
        typeof decoded === 'object' &&
        decoded !== null &&
        (decoded as Record<string, unknown>).kind === TEMP_CHAT_GUEST_TOKEN_KIND
      );
    } catch {
      return false;
    }
  }

  /**
   * 访客握手:TEMP_CHAT_LINK_SECRET 验签 + 房间仍 ACTIVE 未过期 + 座位未离座。
   * 三道都过才放行,并把会话 id 钉在 socket.data 上 —— handleConnection 只让
   * 访客进这一个会话房,拿不到 listConversationIds 的全量会话。
   * 访客没有 app 会话,吊销广播按 sessionId/issuedAtMs 判定天然不命中它;
   * 房间结束/清退走 TempChatService 的 disconnectUser。
   */
  private async authenticateGuest(
    socket: Socket,
    token: string,
  ): Promise<string | null> {
    const secret = this.configService.get<string>('TEMP_CHAT_LINK_SECRET');
    if (!secret) {
      this.logger.warn('TEMP_CHAT_LINK_SECRET 未配置,访客握手一律拒绝');
      return null;
    }
    let payload: GuestChatTokenPayload;
    try {
      payload = this.jwtService.verify<GuestChatTokenPayload>(token, {
        secret,
      });
    } catch {
      return null;
    }
    if (
      payload?.kind !== TEMP_CHAT_GUEST_TOKEN_KIND ||
      typeof payload.guestId !== 'string' ||
      typeof payload.tcId !== 'string' ||
      typeof payload.conversationId !== 'string'
    ) {
      return null;
    }
    if (!(await this.chatService.getActiveTempChat(payload.tcId))) return null;
    if (
      !(await this.chatService.hasSeat(payload.conversationId, payload.guestId))
    )
      return null;
    socket.data.guestConversationId = payload.conversationId;
    socket.data.sessionId = null;
    socket.data.issuedAtMs = null;
    return payload.guestId;
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
    const requested = Array.isArray(payload?.userIds)
      ? payload.userIds.filter((id) => typeof id === 'string').slice(0, 50)
      : [];
    if (requested.length === 0) {
      ack({});
      return;
    }
    // 收窄到「与请求方同处在座会话」的用户。不过滤的话,任何登录账号都能
    // 拿任意 UUID(API 里到处都在返回)持续轮询别人的在线状态 —— 陌生人、
    // 被拉黑的人都能被长期追踪。上下线广播本身就只发到会话房,查询也对齐。
    const userId = socket.data.userId as string;
    const visible = await this.chatService.filterVisiblePresenceTargets(
      userId,
      requested,
    );
    const entries = await Promise.all(
      [...visible].map(
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
      const result = await this.chatService.markRead(
        userId,
        conversationId,
        height,
      );
      reply({ ok: true });
      if (result.advanced) {
        // 播落库后的高度,不是客户端报的那个 —— 后者可能被钳过。
        this.broadcast.emitRead({
          conversationId,
          userId,
          height: result.height,
        });
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
