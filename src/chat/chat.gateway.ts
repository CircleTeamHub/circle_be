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

  private static readonly SUBSCRIBE_RETRY_BASE_MS = 1_000;
  private static readonly SUBSCRIBE_RETRY_MAX_MS = 30_000;
  private revocationSubscribed = false;
  private revocationRetryAttempt = 0;
  private revocationRetryTimer: NodeJS.Timeout | null = null;
  /** access token 到期即断连的计时器,按 socket 保存以便断开时清掉。 */
  private readonly expiryTimers = new Map<Socket, NodeJS.Timeout>();
  /** 多设备是正当需求,但单账号不该能开出无上限的连接来摊薄限流成本。 */
  private static readonly MAX_SOCKETS_PER_USER = 10;
  private readonly connectionsByUser = new Map<string, Set<Socket>>();

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
    this.ensureRevocationSubscription();
    this.logger.log(`chat gateway attached at ${CHAT_WS_PATH}`);
  }

  /**
   * 封禁/登出吊销 → 踢掉在线 chat socket(否则旧连接可继续收发到自然断开)。
   *
   * subscribePattern 从不 reject:连接/psubscribe 失败它自己吞掉并返回 false,
   * Redis 没配也返回 false。所以原来挂的 .catch() 是永远走不到的死代码 ——
   * 启动瞬间 Redis 恰好不可用,订阅就永久缺失,被封禁的人直到自己断线为止
   * 都能继续收发。改成认返回值 + 退避重试(照搬 RealtimeService 的做法)。
   */
  private ensureRevocationSubscription(): void {
    if (this.revocationSubscribed || this.revocationRetryTimer) return;
    // Redis 未配置是部署形态(单实例),不是故障:不重试、不刷日志。
    if (!this.redisService.isEnabled()) return;
    void this.redisService
      .subscribePattern(SESSION_REVOCATION_CHANNEL, (_channel, message) => {
        void this.handleRevocation(message);
      })
      .then((subscribed) => {
        if (subscribed) {
          this.revocationSubscribed = true;
          this.revocationRetryAttempt = 0;
          return;
        }
        this.scheduleRevocationRetry();
      });
  }

  private scheduleRevocationRetry(): void {
    if (this.revocationRetryTimer) return;
    const delay = Math.min(
      ChatGateway.SUBSCRIBE_RETRY_BASE_MS * 2 ** this.revocationRetryAttempt,
      ChatGateway.SUBSCRIBE_RETRY_MAX_MS,
    );
    this.revocationRetryAttempt += 1;
    this.logger.warn(
      `revocation subscribe failed; retrying in ${delay}ms (attempt ${this.revocationRetryAttempt})`,
    );
    this.revocationRetryTimer = setTimeout(() => {
      this.revocationRetryTimer = null;
      this.ensureRevocationSubscription();
    }, delay);
    // 重试计时器不应拖住进程退出。
    this.revocationRetryTimer.unref?.();
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
    socket.data.expMs =
      typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    return payload.sub;
  }

  /**
   * access token 到期即断连。
   *
   * 握手只在连接建立那一刻验一次签,之后 socket 可以活到自然断开为止 ——
   * 不排期断连的话,一条长连接能在 token 过期后继续收发几小时甚至几天,
   * 「让 token 短命」这个前提就不成立了。RealtimeGateway 早就是这么做的
   * (realtime.gateway.ts 的 expiryTimers),chat 侧对齐。
   *
   * 访客 token 走另一条分支(expMs 为 undefined),其时效由房间生命周期兜底。
   */
  private scheduleExpiryDisconnect(socket: Socket): void {
    const expMs = socket.data.expMs as number | null | undefined;
    if (typeof expMs !== 'number') return;
    const ttl = expMs - Date.now();
    if (ttl <= 0) {
      socket.disconnect(true);
      return;
    }
    const timer = setTimeout(() => {
      this.expiryTimers.delete(socket);
      socket.disconnect(true);
    }, ttl);
    timer.unref?.();
    this.expiryTimers.set(socket, timer);
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

    if (!this.claimConnectionSlot(userId, socket)) {
      this.logger.warn(
        `connection cap reached for user ${userId}; rejecting new socket`,
      );
      socket.disconnect(true);
      return;
    }
    this.scheduleExpiryDisconnect(socket);

    // 监听必须**同步**注册,在任何 await 之前。反过来的话,入房那几个 await
    // 期间到达的 chat:send / chat:read 没有任何监听者 —— Socket.IO 直接丢弃
    // 且不回 ack,客户端表现是「刚连上发的第一条消息石沉大海」,且没有任何
    // 错误可供重试判定。处理器统一先 await ready:入房未完成时排队而不是丢。
    let resolveReady!: (ok: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    let conversationIds: string[] = [];

    const whenReady = (run: () => void): void => {
      void ready.then((ok) => {
        if (ok) run();
      });
    };

    socket.on(
      CHAT_EVENTS.send,
      (payload: ChatSendPayload, ack?: AckFn<ChatSendAck>) => {
        whenReady(() => void this.handleSend(socket, userId, payload, ack));
      },
    );
    socket.on(
      CHAT_EVENTS.read,
      (payload: ChatReadPayload, ack?: AckFn<ChatReadAck>) => {
        whenReady(() => void this.handleRead(socket, userId, payload, ack));
      },
    );
    socket.on(CHAT_EVENTS.typing, (payload: ChatTypingPayload) => {
      whenReady(() => void this.handleTyping(socket, userId, payload));
    });
    socket.on(
      CHAT_EVENTS.presence,
      (payload: ChatPresenceQuery, ack?: AckFn<Record<string, boolean>>) => {
        whenReady(() => void this.handlePresenceQuery(socket, payload, ack));
      },
    );
    socket.on('disconnect', () => {
      resolveReady(false);
      this.releaseConnectionSlot(userId, socket);
      const timer = this.expiryTimers.get(socket);
      if (timer) {
        clearTimeout(timer);
        this.expiryTimers.delete(socket);
      }
      // 限流窗口按用户保留:直接清掉等于「断开重连即重置配额」。
      this.sendLimiter.pruneExpired(userId);
      this.readLimiter.pruneExpired(userId);
      this.typingLimiter.pruneExpired(userId);
      this.presenceLimiter.pruneExpired(userId);
      // 末个 socket 断开 = 用户下线,广播到其会话房(尽力而为)。
      void this.broadcast.isUserOnline(userId).then((online) => {
        if (online) return;
        this.broadcast.emitPresence(conversationIds, { userId, online: false });
      });
    });

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
      resolveReady(false);
      socket.disconnect(true);
      return;
    }
    resolveReady(true);

    // 上线广播到其会话房(多设备重复连入时会重复广播 online=true,幂等无害)。
    this.broadcast.emitPresence(conversationIds, { userId, online: true });
  }

  /**
   * 单用户并发连接上限。
   *
   * 限流改成按 userId 计数之后,单条连接吃不满配额了;但一个账号仍然可以开
   * 几百条 socket 摊薄每条的成本,并且每条都占着内存与房间订阅。多设备是正当
   * 需求,所以不是限 1,而是给一个宽松但有界的上限。
   */
  private claimConnectionSlot(userId: string, socket: Socket): boolean {
    const sockets = this.connectionsByUser.get(userId) ?? new Set<Socket>();
    if (sockets.size >= ChatGateway.MAX_SOCKETS_PER_USER) return false;
    sockets.add(socket);
    this.connectionsByUser.set(userId, sockets);
    return true;
  }

  private releaseConnectionSlot(userId: string, socket: Socket): void {
    const sockets = this.connectionsByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.connectionsByUser.delete(userId);
  }

  /** 在线状态查询:一次最多 50 个 userId,ack 回 {userId: online}。 */
  private async handlePresenceQuery(
    socket: Socket,
    payload: ChatPresenceQuery,
    ack?: AckFn<Record<string, boolean>>,
  ): Promise<void> {
    if (typeof ack !== 'function') return;
    const userId = socket.data.userId as string;
    if (!this.presenceLimiter.tryAcquire(userId)) {
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
    // 依赖失败必须收在这里:监听侧是 void this.handlePresenceQuery(...),抛出去
    // 只会变成一条 unhandled rejection,而客户端的 ack 永远等不到 —— 界面上就是
    // 在线状态一直转圈。handleSend / handleRead 都已各自兜住,presence 是漏网的那个。
    try {
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
    } catch (error) {
      // 只记会话与用户 id,不带 requested 列表(那是一串他人 UUID)。
      this.logger.warn(
        `presence query failed user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      ack({});
    }
  }

  private async handleSend(
    socket: Socket,
    userId: string,
    payload: ChatSendPayload,
    ack?: AckFn<ChatSendAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    if (!this.sendLimiter.tryAcquire(userId)) {
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
    if (!this.readLimiter.tryAcquire(userId)) {
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
    if (!this.typingLimiter.tryAcquire(userId)) return;
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
