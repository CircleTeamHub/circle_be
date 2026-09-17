import { randomUUID } from 'crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

/**
 * G-04/G-06:跨实例在线注册表。
 *
 * - `chat:conn:z:{userId}`   该用户所有活着的连接租约(连接数上限判据)
 * - `chat:online:z:{convId}` 会话在线成员集合(在线判定用)
 * - `chat:bg:z:{userId}`     其中退到后台的那些租约(连着、但收不到投递)
 *
 * Redis 未配置时所有读方法返回 null,调用方回退单实例 fetchSockets 语义。
 *
 * 两张表都是 ZSET,score = 该条目的到期时刻,**逐条目**过期;本实例每
 * REFRESH_MS 只抬自己那些条目的 score,实例崩掉不再续期,它留下的幽灵条目
 * 最迟 TTL 到期消失。
 *
 * 早先两处都踩过同一个坑:连接数是一个共享标量 + 整键 TTL,在线成员是普通
 * SET + 整键 TTL。只要该用户(或该会话)还有任何一条活着的连接在续期,
 * 崩溃实例留下的那一份就永远不过期 ——
 * - 在线集合侧:那些人被当成在线,离线推送从此不再发给他们;
 * - 连接计数侧:DECR 减不到 0,最后一条连接断开后用户仍被判在线、也不会从
 *   会话集合里摘掉;反复崩溃还会把计数顶到全局上限,新连接一律被拒。
 * 逐条目租约把这两件事一起根治:计数 = 未过期条目数,断开按 id 精确摘除,
 * 不再有「减掉别人那一份」的可能。
 *
 * 但「最迟 TTL 到期」是 90 分钟:实例崩溃后,它那些「前台」租约让用户在这段时间里
 * 一直被当成正开着 App,推送一条都不发。所以租约成员里带上实例 id,每个实例单独
 * 写一个短 TTL 的心跳(chat:instance:{id});读的时候心跳已经没了的实例留下的租约
 * 一律不算 —— 崩溃后最多 INSTANCE_HEARTBEAT_TTL_SECONDS 就恢复。
 *
 * 租约成员 = `实例 id|socket id|推送 token`(没有 token 为空)。推送按**设备**判断:
 * 只有正开着 App 的那台设备不推,电脑上开着网页版不影响手机收推送。
 */
const KEY_TTL_SECONDS = 90 * 60;
const REFRESH_MS = 20 * 60 * 1000;
const INSTANCE_HEARTBEAT_TTL_SECONDS = 90;
const INSTANCE_HEARTBEAT_MS = 20_000;
const LEASE_SEPARATOR = '|';

/** :z 后缀区分数据结构 —— 与旧的标量/SET 版本共存时不会撞 WRONGTYPE。 */
const connKey = (userId: string): string => `chat:conn:z:${userId}`;
const onlineKey = (conversationId: string): string =>
  `chat:online:z:${conversationId}`;
const backgroundKey = (userId: string): string => `chat:bg:z:${userId}`;
const instanceKey = (instanceId: string): string =>
  `chat:instance:${instanceId}`;

/** 租约成员拆回实例 id 与推送 token。旧版本写的是裸 socket id:两者都是 null。 */
function parseLease(member: string): {
  instanceId: string | null;
  pushToken: string | null;
} {
  const parts = member.split(LEASE_SEPARATOR);
  if (parts.length < 3) return { instanceId: null, pushToken: null };
  return {
    instanceId: parts[0] || null,
    pushToken: parts.slice(2).join(LEASE_SEPARATOR) || null,
  };
}

@Injectable()
export class ChatPresenceRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatPresenceRegistry.name);
  /** 本实例的 id:写进每条租约,心跳也按它写。 */
  private readonly instanceId = randomUUID();
  /**
   * 本实例在线用户 → 其连接租约(socket id → Redis 里的租约成员)、其中退到后台的
   * socket 与会话集合(续期与断连清理的依据)。
   */
  private readonly localUsers = new Map<
    string,
    {
      leases: Map<string, string>;
      background: Set<string>;
      conversations: Set<string>;
    }
  >();
  private refreshTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    if (!this.redis.isEnabled()) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshLocal();
    }, REFRESH_MS);
    this.refreshTimer.unref?.();
    void this.heartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, INSTANCE_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      // 正常下线:心跳立刻撤掉,本实例的租约马上不再算数(不用等它过期)。
      void this.redis.deleteKey(instanceKey(this.instanceId));
    }
  }

  /**
   * 连接建立第一步:登记一条连接租约,返回该用户的全局连接数(上限判据)。
   *
   * socketId 用 socket.id —— 断开时按它精确摘除。pushToken 是这台设备登记的推送
   * token(网页版、老版本没有):它正开着 App 时推送跳过这台设备。null = Redis 不可用
   * (未配置,或这一刻连不上/命令失败),调用方回退本实例计数;超限时调用方
   * 要调 socketDisconnected 把这条租约撤回去。
   */
  async registerSocket(
    userId: string,
    socketId: string,
    pushToken: string | null = null,
  ): Promise<number | null> {
    const local = this.localUsers.get(userId) ?? {
      leases: new Map<string, string>(),
      background: new Set<string>(),
      conversations: new Set<string>(),
    };
    const member = [this.instanceId, socketId, pushToken ?? ''].join(
      LEASE_SEPARATOR,
    );
    local.leases.set(socketId, member);
    this.localUsers.set(userId, local);
    if (!this.redis.isEnabled()) return null;
    const added = await this.redis.addToExpiringSet(
      connKey(userId),
      member,
      KEY_TTL_SECONDS,
    );
    if (added === null) return null;
    const live = await this.liveLeases(userId);
    return live === null ? null : live.length;
  }

  /** 连接建立第二步:会话房派生完成后,把用户挂进各会话在线集合。 */
  async registerConversations(
    userId: string,
    conversationIds: string[],
  ): Promise<void> {
    const local = this.localUsers.get(userId);
    for (const id of conversationIds) local?.conversations.add(id);
    if (!this.redis.isEnabled()) return;
    for (const id of conversationIds) {
      await this.redis.addToExpiringSet(onlineKey(id), userId, KEY_TTL_SECONDS);
    }
  }

  /**
   * 连接断开:撤掉这条租约;该用户再无活着的租约才从各会话集合摘除
   * (多端/多实例并存)。
   *
   * 按 leaseId 精确摘除,所以「这条连接当初到底登记成功没有」不再需要调用方
   * 转达:没登记上的 ZREM 是个无害的空操作,也绝不会误伤别的实例上那条活着的
   * 连接(旧的共享标量 DECR 会)。
   */
  async socketDisconnected(userId: string, socketId: string): Promise<void> {
    const local = this.localUsers.get(userId);
    const member = local?.leases.get(socketId);
    if (local) {
      local.leases.delete(socketId);
      local.background.delete(socketId);
      if (local.leases.size === 0) this.localUsers.delete(userId);
    }
    if (!this.redis.isEnabled()) return;
    if (member) {
      await this.redis.removeFromExpiringSet(connKey(userId), member);
      await this.redis.removeFromExpiringSet(backgroundKey(userId), member);
    }
    const live = await this.liveLeases(userId);
    // null = Redis 这一刻不可用:宁可留着在线条目(最坏少推几条离线通知),
    // 也不要在读失败时把人误判成离线。剩下的只是崩溃实例的残留时,一并清掉。
    if (live === null || live.length > 0) return;
    const conversations = local?.conversations ?? new Set<string>();
    for (const id of conversations) {
      await this.redis.removeFromExpiringSet(onlineKey(id), userId);
    }
    await this.redis.deleteKey(connKey(userId));
    await this.redis.deleteKey(backgroundKey(userId));
  }

  /**
   * App 退到后台 / 回到前台。
   *
   * 连接本身不断(回前台不用重连、不用补拉),但后台的连接什么都收不到 ——
   * iOS 挂起之后要等 ping 超时(约 45 秒)服务端才发现它没了,安卓进程没被杀
   * 之前连接一直在。推送若把这种连接当在线,锁屏期间的消息就既不推送、也没人看见。
   * 所以「在线」(isOnline / 在线集合,决定对端看到的在线状态)与「收得到」
   * (getDeliverableUserIds,决定要不要推送)是两件事,这里只动后者。
   *
   * 断开之后才到的切换:本实例不再记它(否则会被续期成一条永不过期的死租约);
   * Redis 里那一条最迟 TTL 到期,而死租约不在连接集合里,本来就不影响判定。
   */
  async setSocketBackground(
    userId: string,
    socketId: string,
    background: boolean,
  ): Promise<void> {
    const local = this.localUsers.get(userId);
    const member = local?.leases.get(socketId);
    // 断开之后才到的切换:这条租约已经撤了,不再记。
    if (!local || !member) return;
    if (background) local.background.add(socketId);
    else local.background.delete(socketId);
    if (!this.redis.isEnabled()) return;
    if (background) {
      await this.redis.addToExpiringSet(
        backgroundKey(userId),
        member,
        KEY_TTL_SECONDS,
      );
    } else {
      await this.redis.removeFromExpiringSet(backgroundKey(userId), member);
    }
  }

  /** 座位变化联动(拉入会话房/被移出会话房时同步集合)。 */
  async conversationJoined(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const local = this.localUsers.get(userId);
    if (local) local.conversations.add(conversationId);
    if (!this.redis.isEnabled()) return;
    const live = await this.liveLeases(userId);
    if (live !== null && live.length > 0) {
      await this.redis.addToExpiringSet(
        onlineKey(conversationId),
        userId,
        KEY_TTL_SECONDS,
      );
    }
  }

  async conversationLeft(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    this.localUsers.get(userId)?.conversations.delete(conversationId);
    if (!this.redis.isEnabled()) return;
    await this.redis.removeFromExpiringSet(onlineKey(conversationId), userId);
  }

  /** 会话在线成员;null = Redis 不可用(调用方回退 fetchSockets)。 */
  async getOnlineUserIds(conversationId: string): Promise<string[] | null> {
    if (!this.redis.isEnabled()) return null;
    return this.redis.getLiveSetMembers(onlineKey(conversationId));
  }

  /**
   * 会话成员里正开着 App 的设备:成员 → 其前台连接登记的推送 token(推送分流用,
   * 这些 token 不推);null = Redis 不可用。
   *
   * 读不到某人的租约时当作他没有前台设备 —— 宁可多推一条,也不把人当成正盯着
   * 屏幕而一条都不推。前台连接没带 token 的(网页版、老版本)不挡任何设备的推送。
   */
  async getForegroundPushTokens(
    conversationId: string,
  ): Promise<Map<string, Set<string>> | null> {
    const online = await this.getOnlineUserIds(conversationId);
    if (online === null) return null;
    const perUser = await Promise.all(
      online.map(async (userId) => {
        const [leases, background] = await Promise.all([
          this.redis.getLiveSetMembers(connKey(userId)),
          this.redis.getLiveSetMembers(backgroundKey(userId)),
        ]);
        if (leases === null || background === null) return null;
        const backgrounded = new Set(background);
        const foreground = leases.filter(
          (member) =>
            !backgrounded.has(member) && parseLease(member).pushToken !== null,
        );
        return foreground.length > 0 ? { userId, foreground } : null;
      }),
    );
    const candidates = perUser.filter(
      (entry): entry is { userId: string; foreground: string[] } =>
        entry !== null,
    );
    const alive = new Set(
      await this.withoutDeadInstances(
        candidates.flatMap((entry) => entry.foreground),
      ),
    );
    const tokensByUser = new Map<string, Set<string>>();
    for (const { userId, foreground } of candidates) {
      const tokens = new Set<string>();
      for (const member of foreground) {
        const { pushToken } = parseLease(member);
        if (alive.has(member) && pushToken) tokens.add(pushToken);
      }
      if (tokens.size > 0) tokensByUser.set(userId, tokens);
    }
    return tokensByUser;
  }

  /**
   * Redis 是否配置。区分两种「答不上来」:
   *   false = 压根没配(单实例) —— socket.io 用内存 adapter,调用方降级到
   *           fetchSockets 是本进程操作,合法且便宜;
   *   true  = 配了但这一刻读失败 —— 挂的是 RedisAdapter,fetchSockets 会变成
   *           经 Redis 的跨节点 RPC,正是刚失败的那条链路,降级到它必然抛。
   */
  isRedisConfigured(): boolean {
    return this.redis.isEnabled();
  }

  /** 全局在线判定;null = Redis 不可用。崩溃实例留下的租约不算。 */
  async isOnline(userId: string): Promise<boolean | null> {
    if (!this.redis.isEnabled()) return null;
    const live = await this.liveLeases(userId);
    return live === null ? null : live.length > 0;
  }

  /** 该用户未过期、且所在实例还活着的租约;null = Redis 不可用。 */
  private async liveLeases(userId: string): Promise<string[] | null> {
    const members = await this.redis.getLiveSetMembers(connKey(userId));
    return members === null ? null : this.withoutDeadInstances(members);
  }

  /**
   * 去掉心跳已经没了的实例留下的租约。本实例的、旧版本写的(不带实例 id)一律保留;
   * 心跳读不到时不过滤 —— 宁可沿用 TTL 兜底的旧语义,也不在读失败时把活人判掉。
   */
  private async withoutDeadInstances(members: string[]): Promise<string[]> {
    const foreign = new Set<string>();
    for (const member of members) {
      const { instanceId } = parseLease(member);
      if (instanceId && instanceId !== this.instanceId) foreign.add(instanceId);
    }
    if (foreign.size === 0) return members;
    const ids = [...foreign];
    const beats = await this.redis.getJsonMany<number>(ids.map(instanceKey), {
      strict: true,
    });
    if (beats === null) return members;
    const dead = new Set(ids.filter((_, index) => beats[index] === null));
    if (dead.size === 0) return members;
    return members.filter((member) => {
      const { instanceId } = parseLease(member);
      return !instanceId || !dead.has(instanceId);
    });
  }

  private async heartbeat(): Promise<void> {
    await this.redis.setJson(
      instanceKey(this.instanceId),
      Date.now(),
      INSTANCE_HEARTBEAT_TTL_SECONDS,
    );
  }

  private async refreshLocal(): Promise<void> {
    try {
      for (const [userId, local] of this.localUsers) {
        for (const member of local.leases.values()) {
          // ZADD 幂等,只抬**本实例这几条**的到期时刻 —— 崩溃实例留下的条目
          // 该到期照样到期。
          await this.redis.addToExpiringSet(
            connKey(userId),
            member,
            KEY_TTL_SECONDS,
          );
        }
        for (const socketId of local.background) {
          const member = local.leases.get(socketId);
          if (!member) continue;
          await this.redis.addToExpiringSet(
            backgroundKey(userId),
            member,
            KEY_TTL_SECONDS,
          );
        }
        for (const id of local.conversations) {
          await this.redis.addToExpiringSet(
            onlineKey(id),
            userId,
            KEY_TTL_SECONDS,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `presence refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
