import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

/**
 * G-04/G-06:跨实例在线注册表。
 *
 * - `chat:conn:{userId}`   全局连接计数(多端/多实例求和),兼做连接数上限判据
 * - `chat:online:{convId}` 会话在线成员集合(推送分流 / 在线判定用)
 *
 * Redis 未配置时所有读方法返回 null,调用方回退单实例 fetchSockets 语义。
 * 崩溃自愈:条目**逐成员**带到期时刻(ZSET score),本实例每 REFRESH_MS 只抬自己
 * 那些成员的 score;实例崩掉不再续期,它留下的幽灵成员最迟 TTL 到期消失。
 * (早先用的是普通 SET + 整键 TTL:会话里只要还有一个人在线,续期就把整个键
 * 一起续上,崩溃实例留下的成员于是永不过期 —— 这些人被当成在线,离线推送
 * 从此不再发给他们。)
 */
const KEY_TTL_SECONDS = 90 * 60;
const REFRESH_MS = 20 * 60 * 1000;

const connKey = (userId: string): string => `chat:conn:${userId}`;
/** :z 后缀区分数据结构 —— 与旧的 SET 版本共存时不会撞 WRONGTYPE。 */
const onlineKey = (conversationId: string): string =>
  `chat:online:z:${conversationId}`;

@Injectable()
export class ChatPresenceRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(ChatPresenceRegistry.name);
  /** 本实例在线用户 → 其会话集合(续期与断连清理的依据)。 */
  private readonly localUsers = new Map<
    string,
    { sockets: number; conversations: Set<string> }
  >();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly redis: RedisService) {
    if (this.redis.isEnabled()) {
      this.refreshTimer = setInterval(() => {
        void this.refreshLocal();
      }, REFRESH_MS);
      this.refreshTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /**
   * 连接建立第一步:全局计数 +1,返回全局连接数(连接上限判据)。
   * null = Redis 不可用(未配置,或这一刻连不上/命令失败),调用方回退本实例计数;
   * 超限时调用方要调 socketDisconnected 把这一次 +1 退回去 —— 并且必须把
   * 「这次到底加没加成」如实传回来(见 socketDisconnected)。
   */
  async registerSocket(userId: string): Promise<number | null> {
    const local = this.localUsers.get(userId) ?? {
      sockets: 0,
      conversations: new Set<string>(),
    };
    local.sockets += 1;
    this.localUsers.set(userId, local);
    if (!this.redis.isEnabled()) return null;
    return this.redis.incrementWithTtl(connKey(userId), KEY_TTL_SECONDS);
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
   * 连接断开:全局计数 -1;归零才从各会话集合摘除(多端/多实例并存)。
   *
   * `hadRedisLease=false` 表示这条连接建立时的 +1 根本没成功(Redis 那会儿不可用),
   * 此时**不能**减。减了的话:同一用户在另一实例上那条活着的连接的计数会被这次
   * 断开抹到 0,人被判成离线、从所有会话在线集合里摘掉 —— 于是他既在线着收 socket
   * 消息,又同时开始收离线推送,连接上限也少算了一个。
   */
  async socketDisconnected(
    userId: string,
    hadRedisLease = true,
  ): Promise<void> {
    const local = this.localUsers.get(userId);
    if (local) {
      local.sockets -= 1;
      if (local.sockets <= 0) this.localUsers.delete(userId);
    }
    if (!this.redis.isEnabled() || !hadRedisLease) return;
    const remaining = await this.redis.decrementFloorZero(connKey(userId));
    if (remaining !== 0) return;
    const conversations = local?.conversations ?? new Set<string>();
    for (const id of conversations) {
      await this.redis.removeFromExpiringSet(onlineKey(id), userId);
    }
    await this.redis.deleteKey(connKey(userId));
  }

  /** 座位变化联动(拉入会话房/被移出会话房时同步集合)。 */
  async conversationJoined(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const local = this.localUsers.get(userId);
    if (local) local.conversations.add(conversationId);
    if (!this.redis.isEnabled()) return;
    const online = await this.redis.getCounter(connKey(userId));
    if (online !== null && online > 0) {
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

  /** 全局在线判定;null = Redis 不可用。 */
  async isOnline(userId: string): Promise<boolean | null> {
    if (!this.redis.isEnabled()) return null;
    const count = await this.redis.getCounter(connKey(userId));
    return count === null ? null : count > 0;
  }

  private async refreshLocal(): Promise<void> {
    try {
      for (const [userId, local] of this.localUsers) {
        await this.redis.touchTtl(connKey(userId), KEY_TTL_SECONDS);
        for (const id of local.conversations) {
          // ZADD 幂等,只抬**自己这一条**的到期时刻 —— 别的实例留下的成员
          // 该到期照样到期。
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
