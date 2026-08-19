import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
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
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import {
  CHAT_EVENTS,
  CHAT_RATE_LIMITS,
  CHAT_WS_PATH,
  TEMP_CHAT_GUEST_TOKEN_KIND,
  conversationRoom,
  userRoom,
} from './chat.constants';
import { DistributedRateLimiter } from './chat-rate-limiter';
import { ChatPresenceRegistry } from './chat-presence.registry';
import { createAdapter } from '@socket.io/redis-adapter';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatPushService } from './chat-push.service';
import { ChatService } from './chat.service';
import {
  chatMetrics as defaultChatMetrics,
  type ChatMetrics,
} from './chat-metrics';
import type {
  ChatAckError,
  GuestChatTokenPayload,
  ChatPresenceQuery,
  ChatReadAck,
  ChatReadPayload,
  ChatDeliveredPayload,
  ChatEditPayload,
  ChatReactionPayload,
  ChatRevokePayload,
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
export class ChatGateway implements OnModuleDestroy {
  private readonly logger = new Logger(ChatGateway.name);
  private metrics: ChatMetrics = defaultChatMetrics;
  private io: Server | null = null;

  // G-04:限流走 Redis ZSET 滑动窗口(跨实例全局配额),Redis 缺席回退每实例本地。
  private readonly sendLimiter: DistributedRateLimiter;
  private readonly readLimiter: DistributedRateLimiter;
  private readonly typingLimiter: DistributedRateLimiter;
  private readonly presenceLimiter: DistributedRateLimiter;
  private readonly revokeLimiter: DistributedRateLimiter;
  private readonly deliveredLimiter: DistributedRateLimiter;
  private readonly reactionLimiter: DistributedRateLimiter;
  private readonly editLimiter: DistributedRateLimiter;

  private static readonly SUBSCRIBE_RETRY_BASE_MS = 1_000;
  private static readonly SUBSCRIBE_RETRY_MAX_MS = 30_000;
  private revocationSubscribed = false;
  private revocationRetryAttempt = 0;
  private revocationRetryTimer: NodeJS.Timeout | null = null;
  /** Redis adapter 挂载重试(启动时 Redis 不可用 → 房间广播会退化成单实例)。 */
  private static readonly ADAPTER_RETRY_BASE_MS = 5_000;
  private static readonly ADAPTER_RETRY_MAX_MS = 60_000;
  /** 连续失败到这个次数时报一次 error(之后只静默退避,不刷屏)。 */
  private static readonly ADAPTER_WARN_AFTER_ATTEMPTS = 5;
  private adapterAttempts = 0;
  private adapterRetryTimer: NodeJS.Timeout | null = null;
  /** access token 到期即断连的计时器,按 socket 保存以便断开时清掉。 */
  private readonly expiryTimers = new Map<Socket, NodeJS.Timeout>();
  /** 多设备是正当需求,但单账号不该能开出无上限的连接来摊薄限流成本。 */
  private static readonly MAX_SOCKETS_PER_USER = 10;
  /** 初始化期间只保留一个小型 FIFO；超过它说明客户端正在洪泛而不是正常抢发。 */
  private static readonly MAX_PRE_READY_EVENTS = 64;
  private readonly connectionsByUser = new Map<string, Set<Socket>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly sessionRevocation: SessionRevocationService,
    private readonly chatService: ChatService,
    private readonly broadcast: ChatBroadcastService,
    private readonly chatPush: ChatPushService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly presence: ChatPresenceRegistry,
  ) {
    const make = (
      name: keyof typeof CHAT_RATE_LIMITS,
    ): DistributedRateLimiter =>
      new DistributedRateLimiter(
        name,
        CHAT_RATE_LIMITS[name].limit,
        CHAT_RATE_LIMITS[name].windowMs,
        this.redisService,
      );
    this.sendLimiter = make('send');
    this.readLimiter = make('read');
    this.typingLimiter = make('typing');
    this.presenceLimiter = make('presence');
    this.revokeLimiter = make('revoke');
    this.deliveredLimiter = make('delivered');
    this.reactionLimiter = make('reaction');
    this.editLimiter = make('edit');
  }

  /**
   * SIGTERM 时必须主动关掉 Socket.IO。
   *
   * app.close() 只关 HTTP server,而已经升级成 WebSocket 的连接不算在内 ——
   * 只要还有一个聊天客户端连着,close 就一直 pending,进程挂到编排器超时后被
   * SIGKILL:优雅退出的清理和日志 flush 全部跳过。任何一个连着的客户端都能
   * 单方面把发布卡在这一步。RealtimeGateway 早就有这个钩子,chat 侧漏了。
   *
   * 计时器也要一并清:退避重试和 token 到期断连都是 setTimeout,虽然都
   * unref 过(不阻止退出),但留着会在关闭后继续对已销毁的 io 动手。
   */
  onModuleDestroy(): void {
    if (this.revocationRetryTimer) {
      clearTimeout(this.revocationRetryTimer);
      this.revocationRetryTimer = null;
    }
    if (this.adapterRetryTimer) {
      clearTimeout(this.adapterRetryTimer);
      this.adapterRetryTimer = null;
    }
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.connectionsByUser.clear();
    this.io?.close();
    this.io = null;
  }

  attach(httpServer: HttpServer, options: { corsOrigin: CorsOrigin }): void {
    const io = new Server(httpServer, {
      path: CHAT_WS_PATH,
      cors: { origin: options.corsOrigin, credentials: true },
      // 单条 socket 报文上限,与 content 8KB 上限同数量级留余量。
      maxHttpBufferSize: 64 * 1024,
    });
    // G-04:Redis adapter 让房间广播跨实例;未配 Redis 保持单实例语义。
    void this.attachRedisAdapter(io);

    io.use((socket, next) => {
      void this.authenticate(socket)
        .then((userId) => {
          if (!userId) {
            this.metrics.observeAuthFailure('rejected');
            next(new Error('unauthorized'));
            return;
          }
          socket.data.userId = userId;
          next();
        })
        .catch((error: unknown) => {
          this.metrics.observeAuthFailure('error');
          reportOperationalError(error, {
            component: 'ChatGateway',
            operation: 'handshakeAuth',
            kind: 'websocket',
          });
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
   * G-04:adapter 让 to(room).emit 跨实例投递。pub 复用命令连接、sub 独立连接,
   * 都由 RedisService 管生命周期;未配 Redis 就保持单实例语义。
   *
   * 配了 Redis 但启动那一刻连不上,必须重试。原来一次拿不到就放弃:进程活着、
   * RedisService 随后自己重连成功,于是**在线注册表是跨实例的、房间广播却仍是
   * 本实例的** —— 别的实例上的用户被判成在线(不推离线通知),消息又跨不过去,
   * 结果是这些人既收不到 socket 消息也收不到推送,直到重启。
   */
  private async attachRedisAdapter(io: Server): Promise<void> {
    if (!this.redisService.isEnabled()) return;
    // 重试**不设次数上限**,只做退避。
    //
    // 上一版封了 10 次 × 5 秒 = 50 秒就永久放弃 —— 而这正是最该坚持的场景:
    // Redis 停机往往不止一分钟,进程却活着,RedisService 随后自己就连上了。
    // 那之后在线注册表是跨实例的、房间广播却仍是本实例的:别的实例上的用户
    // 被判成在线(不推离线通知),消息又跨不过去,这些人既收不到 socket 消息
    // 也收不到推送,直到重启为止。宁可一直退避重试,也不能进入这个状态。
    let delay = ChatGateway.ADAPTER_RETRY_BASE_MS;
    for (;;) {
      const clients = await this.redisService.getAdapterClients();
      if (clients) {
        io.adapter(createAdapter(clients.pub, clients.sub));
        this.logger.log(
          'chat gateway: redis adapter attached (multi-instance)',
        );
        return;
      }
      this.adapterAttempts += 1;
      if (this.adapterAttempts === ChatGateway.ADAPTER_WARN_AFTER_ATTEMPTS) {
        this.logger.error(
          'chat gateway: redis adapter still unavailable; realtime is ' +
            'per-instance until it attaches (cross-instance delivery is lost)',
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
        this.adapterRetryTimer = timer;
      });
      // onModuleDestroy 之后不再重试(io 已销毁)。
      if (this.io === null) return;
      delay = Math.min(delay * 2, ChatGateway.ADAPTER_RETRY_MAX_MS);
    }
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
    // 管理台走 /auth/admin/login 拿的是 ADMIN audience,它同样能过签名校验 ——
    // 而管理台压根没有消息 UI。拆 OpenIM 之前这道闸在 /auth/im-token 里(显式拒
    // ADMIN),自研栈直接复用 app JWT 连 socket,闸随端点一起没了。这是迁移带回来
    // 的能力扩张,不是新需求。REST 侧同源判定见 AppAudienceGuard。
    if (payload.aud !== 'APP') return null;
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
      this.metrics.observeConnectionRejected('per_user_limit');
      this.logger.warn(
        `connection cap reached for user ${userId}; rejecting new socket`,
      );
      socket.disconnect(true);
      return;
    }
    // opened 必须与 disconnect 监听器的 closed 配对,且**先于**它注册:反过来的话
    // presence 注册期间断开、或全局上限拒绝,都会在没有 opened 的情况下触发一次
    // closed —— chat_connections_active 这个 Gauge 会一路 dec 成负数。
    this.metrics.observeConnectionOpened(this.connectionsByUser.size);

    // 监听必须**同步**注册,在任何 await 之前。全局 presence 注册和入房都可能被
    // Redis/数据库拖慢；这段窗口里的首条消息要等 ready 后处理,不能被 Socket.IO
    // 当成无人监听的事件直接丢掉。
    let admissionState: 'pending' | 'ready' | 'failed' = 'pending';
    const preReadyQueue: Array<() => Promise<void>> = [];
    let drainingPreReadyQueue = false;
    let conversationIds: string[] = [];
    // 上下线广播要剔掉互相拉黑的人 —— 座位还在,不剔就等于换个通道继续推送。
    let blockedPeers: string[] = [];

    const failAdmission = (): void => {
      admissionState = 'failed';
      preReadyQueue.length = 0;
    };
    const drainPreReadyQueue = async (): Promise<void> => {
      if (drainingPreReadyQueue || admissionState !== 'ready') return;
      drainingPreReadyQueue = true;
      try {
        while (admissionState === 'ready' && preReadyQueue.length > 0) {
          const run = preReadyQueue.shift();
          if (!run) continue;
          // 单条排队事件失败不能带走整条队列。让它抛出去会中止 drain,而
          // admissionState 仍是 ready —— 之后的新事件直接走即时分支,没人再回来
          // 排空剩下的积压:那些消息既不执行也不回 ack,在客户端看就是凭空消失。
          // 各 handler 内部已各自回过错误 ack,这里只兜住漏到外面的 rejection
          // (限流器的 tryAcquire 就在各自的 try 之外)。
          try {
            await run();
          } catch (error) {
            this.logger.warn(
              `pre-ready event failed for user ${userId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } finally {
        drainingPreReadyQueue = false;
      }
    };
    const whenReady = (run: () => Promise<void>): boolean => {
      if (admissionState === 'ready') {
        void run();
        return true;
      }
      if (admissionState === 'failed') return false;
      if (preReadyQueue.length >= ChatGateway.MAX_PRE_READY_EVENTS) {
        failAdmission();
        this.metrics.observeConnectionRejected('pre_ready_overflow');
        socket.disconnect(true);
        return false;
      }
      preReadyQueue.push(run);
      return true;
    };

    socket.on(
      CHAT_EVENTS.send,
      (payload: ChatSendPayload, ack?: AckFn<ChatSendAck>) => {
        if (!whenReady(() => this.handleSend(socket, userId, payload, ack))) {
          this.ackOnce(ack)(
            this.ackError(ChatErrorCode.RateLimited, '连接初始化请求过多'),
          );
        }
      },
    );
    socket.on(
      CHAT_EVENTS.read,
      (payload: ChatReadPayload, ack?: AckFn<ChatReadAck>) => {
        if (!whenReady(() => this.handleRead(socket, userId, payload, ack))) {
          this.ackOnce(ack)(
            this.ackError(ChatErrorCode.RateLimited, '连接初始化请求过多'),
          );
        }
      },
    );
    socket.on(CHAT_EVENTS.typing, (payload: ChatTypingPayload) => {
      whenReady(() => this.handleTyping(socket, userId, payload));
    });
    socket.on(
      CHAT_EVENTS.revoke,
      (payload: ChatRevokePayload, ack?: AckFn<ChatReadAck>) => {
        if (!whenReady(() => this.handleRevoke(userId, payload, ack))) {
          this.ackOnce(ack)(
            this.ackError(ChatErrorCode.RateLimited, '连接初始化请求过多'),
          );
        }
      },
    );
    socket.on(CHAT_EVENTS.delivered, (payload: ChatDeliveredPayload) => {
      whenReady(() => this.handleDelivered(userId, payload));
    });
    socket.on(
      CHAT_EVENTS.reaction,
      (payload: ChatReactionPayload, ack?: AckFn<ChatReadAck>) => {
        if (!whenReady(() => this.handleReaction(userId, payload, ack))) {
          this.ackOnce(ack)(
            this.ackError(ChatErrorCode.RateLimited, '连接初始化请求过多'),
          );
        }
      },
    );
    socket.on(
      CHAT_EVENTS.edit,
      (payload: ChatEditPayload, ack?: AckFn<ChatReadAck>) => {
        if (!whenReady(() => this.handleEdit(userId, payload, ack))) {
          this.ackOnce(ack)(
            this.ackError(ChatErrorCode.RateLimited, '连接初始化请求过多'),
          );
        }
      },
    );
    socket.on(
      CHAT_EVENTS.presence,
      (payload: ChatPresenceQuery, ack?: AckFn<Record<string, boolean>>) => {
        if (!whenReady(() => this.handlePresenceQuery(socket, payload, ack))) {
          if (typeof ack === 'function') ack({});
        }
      },
    );
    socket.on('disconnect', () => {
      failAdmission();
      this.releaseConnectionSlot(userId, socket);
      void this.presence.socketDisconnected(userId, socket.id);
      this.metrics.observeConnectionClosed(this.connectionsByUser.size);
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
      this.revokeLimiter.pruneExpired(userId);
      this.deliveredLimiter.pruneExpired(userId);
      this.reactionLimiter.pruneExpired(userId);
      this.editLimiter.pruneExpired(userId);
      // 末个 socket 断开 = 用户下线,广播到其会话房(尽力而为)。
      void this.broadcast.isUserOnline(userId).then((online) => {
        if (online) return;
        this.observeBroadcast('presence', () =>
          this.broadcast.emitPresence(
            conversationIds,
            { userId, online: false },
            blockedPeers,
          ),
        );
      });
    });

    // G-04:上限还要按**全局**计一遍 —— 本实例的 Map 在多实例下会放大成 10×N。
    // 租约 id 用 socket.id:断开时按它精确摘除,不会误伤同一用户在别处
    // 那条活着的连接(共享标量 DECR 会)。
    const globalCount = await this.presence.registerSocket(userId, socket.id);
    // presence 注册期间断开时,上面的监听器先清理一次；await 返回后再清一次,
    // 覆盖“删除先于注册落地”的时序,避免留下跨实例在线脏数据。
    if (socket.disconnected) {
      void this.presence.socketDisconnected(userId, socket.id);
      this.releaseConnectionSlot(userId, socket);
      return;
    }
    if (
      globalCount !== null &&
      globalCount > ChatGateway.MAX_SOCKETS_PER_USER
    ) {
      this.logger.warn(
        `global connection cap reached for user ${userId} (${globalCount}); rejecting`,
      );
      void this.presence.socketDisconnected(userId, socket.id);
      this.releaseConnectionSlot(userId, socket);
      failAdmission();
      socket.disconnect(true);
      return;
    }
    this.scheduleExpiryDisconnect(socket);

    try {
      if (guestConversationId) {
        conversationIds = [guestConversationId];
      } else {
        [conversationIds, blockedPeers] = await Promise.all([
          this.chatService.listConversationIds(userId),
          this.chatService.listBlockedCounterparties(userId),
        ]);
      }
      await socket.join(userRoom(userId));
      await socket.join(conversationIds.map(conversationRoom));
    } catch (error) {
      // 房间加入失败的连接是"在线但收不到任何推送"的哑连接,直接断开让客户端重连。
      reportOperationalError(error, {
        component: 'ChatGateway',
        operation: 'joinRooms',
        kind: 'websocket',
      });
      this.logger.error(
        `join rooms failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.metrics.observeConnectionRejected('join_failed');
      failAdmission();
      socket.disconnect(true);
      return;
    }
    admissionState = 'ready';
    void drainPreReadyQueue();
    // 会话房派生完成 → 挂进跨实例在线集合(推送分流/在线判定的数据源)。
    void this.presence.registerConversations(userId, conversationIds);

    // 上线广播到其会话房(多设备重复连入时会重复广播 online=true,幂等无害)。
    this.observeBroadcast('presence', () =>
      this.broadcast.emitPresence(
        conversationIds,
        { userId, online: true },
        blockedPeers,
      ),
    );
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
    const startedAt = process.hrtime.bigint();
    const userId = socket.data.userId as string;
    try {
      if (!(await this.presenceLimiter.tryAcquire(userId))) {
        this.metrics.observeEvent('presence', 'rate_limited');
        ack({});
        return;
      }
      const requested = Array.isArray(payload?.userIds)
        ? payload.userIds.filter((id) => typeof id === 'string').slice(0, 50)
        : [];
      if (requested.length === 0) {
        this.metrics.observeEvent('presence', 'success');
        ack({});
        return;
      }
      // 收窄到「与请求方同处在座会话」的用户。不过滤的话,任何登录账号都能
      // 拿任意 UUID(API 里到处都在返回)持续轮询别人的在线状态 —— 陌生人、
      // 被拉黑的人都能被长期追踪。上下线广播本身就只发到会话房,查询也对齐。
      // 依赖失败必须收在这里:监听侧是 void this.handlePresenceQuery(...),抛出去
      // 只会变成一条 unhandled rejection,而客户端的 ack 永远等不到 —— 界面上就是
      // 在线状态一直转圈。handleSend / handleRead 都已各自兜住,presence 是漏网的那个。
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
      this.metrics.observeEvent('presence', 'success');
    } catch (error) {
      this.metrics.observeEvent('presence', 'failure');
      reportOperationalError(error, {
        component: 'ChatGateway',
        operation: 'presence',
        kind: 'websocket',
      });
      // 只记会话与用户 id,不带 requested 列表(那是一串他人 UUID)。
      this.logger.warn(
        `presence query failed user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      ack({});
    } finally {
      this.metrics.observeAckDuration(
        'presence',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
    }
  }

  private async handleSend(
    socket: Socket,
    userId: string,
    payload: ChatSendPayload,
    ack?: AckFn<ChatSendAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    const startedAt = process.hrtime.bigint();
    try {
      if (!(await this.sendLimiter.tryAcquire(userId))) {
        this.metrics.observeEvent('send', 'rate_limited');
        reply(this.ackError(ChatErrorCode.RateLimited, '发送太频繁'));
        return;
      }
      const result = await this.chatService.sendMessage(userId, payload);
      this.metrics.observeEvent('send', 'success');
      reply({
        ok: true,
        messageId: result.message.id,
        height: result.message.height,
        d: result.message.d ?? payload.d,
      });
      // 幂等复用(断线重发撞库)不再广播,首次投递时房间里已经收到过了。
      if (!result.reused) {
        this.observeBroadcast('message', () =>
          this.broadcast.emitMessage(result.message),
        );
        // 离线成员推送:best-effort,不阻塞发送方 ack 路径。
        void this.chatPush.onMessageBroadcast(result.message);
      }
    } catch (error) {
      this.metrics.observeEvent('send', 'failure');
      reply(this.toAckError(error, 'send', userId, payload?.conversationId));
    } finally {
      this.metrics.observeAckDuration(
        'send',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
    }
  }

  private async handleRead(
    socket: Socket,
    userId: string,
    payload: ChatReadPayload,
    ack?: AckFn<ChatReadAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    const startedAt = process.hrtime.bigint();
    try {
      if (!(await this.readLimiter.tryAcquire(userId))) {
        this.metrics.observeEvent('read', 'rate_limited');
        reply(this.ackError(ChatErrorCode.RateLimited));
        return;
      }
      const conversationId = payload?.conversationId;
      const height = Number(payload?.height);
      const result = await this.chatService.markRead(
        userId,
        conversationId,
        height,
      );
      this.metrics.observeEvent('read', 'success');
      reply({ ok: true });
      if (result.advanced) {
        // 播落库后的高度,不是客户端报的那个 —— 后者可能被钳过。
        this.observeBroadcast('read', () =>
          this.broadcast.emitRead({
            conversationId,
            userId,
            height: result.height,
          }),
        );
      }
    } catch (error) {
      this.metrics.observeEvent('read', 'failure');
      reply(this.toAckError(error, 'read', userId, payload?.conversationId));
    } finally {
      this.metrics.observeAckDuration(
        'read',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
    }
  }

  /** G-07 送达:无 ack 尽力而为(丢了影响小,下一条消息会再报更高水位)。 */
  private async handleDelivered(
    userId: string,
    payload: ChatDeliveredPayload,
  ): Promise<void> {
    if (!(await this.deliveredLimiter.tryAcquire(userId))) return;
    try {
      const conversationId = payload?.conversationId;
      const height = Number(payload?.height);
      if (typeof conversationId !== 'string' || conversationId.length === 0) {
        return;
      }
      const result = await this.chatService.markDelivered(
        userId,
        conversationId,
        height,
      );
      if (result.advanced) {
        this.broadcast.emitDelivered({
          conversationId,
          userId,
          height: result.height,
        });
      }
    } catch (error) {
      this.logger.debug(
        `delivered report dropped user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** G-07 表情回应:白名单与成员校验在 service;无变化不广播(幂等重放静默)。 */
  private async handleReaction(
    userId: string,
    payload: ChatReactionPayload,
    ack?: AckFn<ChatReadAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    if (!(await this.reactionLimiter.tryAcquire(userId))) {
      reply(this.ackError(ChatErrorCode.RateLimited));
      return;
    }
    try {
      const { conversationId, messageId, emoji, op } = payload ?? {};
      if (
        typeof conversationId !== 'string' ||
        typeof messageId !== 'string' ||
        typeof emoji !== 'string' ||
        (op !== 'add' && op !== 'remove')
      ) {
        reply(this.ackError(ChatErrorCode.InvalidPayload));
        return;
      }
      const result = await this.chatService.toggleReaction(
        userId,
        conversationId,
        messageId,
        emoji,
        op,
      );
      reply({ ok: true });
      if (result.changed) {
        this.broadcast.emitReaction({
          conversationId,
          messageId,
          emoji,
          op,
          userId,
        });
      }
    } catch (error) {
      reply(
        this.toAckError(error, 'reaction', userId, payload?.conversationId),
      );
    }
  }

  /** G-07 编辑:authz/窗口/敏感词在 service;成功即广播新 content。 */
  private async handleEdit(
    userId: string,
    payload: ChatEditPayload,
    ack?: AckFn<ChatReadAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    if (!(await this.editLimiter.tryAcquire(userId))) {
      reply(this.ackError(ChatErrorCode.RateLimited));
      return;
    }
    try {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      if (typeof conversationId !== 'string' || typeof messageId !== 'string') {
        reply(this.ackError(ChatErrorCode.InvalidPayload));
        return;
      }
      const dto = await this.chatService.editMessage(
        userId,
        conversationId,
        messageId,
        payload?.content,
      );
      reply({ ok: true });
      this.broadcast.emitEdit({
        conversationId,
        messageId,
        content: dto.content,
        editedAt: dto.editedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      reply(this.toAckError(error, 'edit', userId, payload?.conversationId));
    }
  }

  /** G-02 撤回:权限与广播都在 service 内收口,这里只做限流与 ack。 */
  private async handleRevoke(
    userId: string,
    payload: ChatRevokePayload,
    ack?: AckFn<ChatReadAck>,
  ): Promise<void> {
    const reply = this.ackOnce(ack);
    if (!(await this.revokeLimiter.tryAcquire(userId))) {
      reply(this.ackError(ChatErrorCode.RateLimited));
      return;
    }
    try {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      if (
        typeof conversationId !== 'string' ||
        conversationId.length === 0 ||
        typeof messageId !== 'string' ||
        messageId.length === 0
      ) {
        reply(this.ackError(ChatErrorCode.InvalidPayload));
        return;
      }
      await this.chatService.revokeMessage(userId, conversationId, messageId);
      reply({ ok: true });
    } catch (error) {
      reply(this.toAckError(error, 'revoke', userId, payload?.conversationId));
    }
  }

  private async handleTyping(
    socket: Socket,
    userId: string,
    payload: ChatTypingPayload,
  ): Promise<void> {
    if (!(await this.typingLimiter.tryAcquire(userId))) {
      this.metrics.observeEvent('typing', 'rate_limited');
      return;
    }
    const conversationId = payload?.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      this.metrics.observeEvent('typing', 'failure');
      return;
    }
    // typing 是尽力而为的提示,不做成员查询放大;但只对本人已在的房间转发,
    // socket.rooms 本身就是服务端派生的成员关系,非成员房不会命中。
    if (!socket.rooms.has(conversationRoom(conversationId))) {
      this.metrics.observeEvent('typing', 'failure');
      return;
    }
    this.metrics.observeEvent('typing', 'success');
    this.observeBroadcast('typing', () =>
      this.broadcast.emitTyping({ conversationId, userId }, socket.id),
    );
  }

  private observeBroadcast(
    action: 'message' | 'read' | 'typing' | 'presence',
    callback: () => void,
  ): void {
    const startedAt = process.hrtime.bigint();
    try {
      callback();
    } finally {
      this.metrics.observeBroadcast(
        action,
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
    }
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
      if (error.getStatus() < 500) {
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
        return this.ackError(ChatErrorCode.InvalidPayload, '请求失败');
      }
    }
    reportOperationalError(error, {
      component: 'ChatGateway',
      operation: action,
      kind: 'websocket',
    });
    this.logger.error(
      `chat ${action} failed user=${userId} conversation=${conversationId ?? '-'}: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    return this.ackError(ChatErrorCode.InvalidPayload, '请求失败');
  }
}
