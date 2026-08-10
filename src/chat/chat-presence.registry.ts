import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

/**
 * G-04/G-06:跨实例在线注册表。
 *
 * - `chat:conn:z:{userId}`   该用户所有活着的连接租约(连接数上限判据)
 * - `chat:online:z:{convId}` 会话在线成员集合(推送分流 / 在线判定用)
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
 */
const KEY_TTL_SECONDS = 90 * 60;
const REFRESH_MS = 20 * 60 * 1000;

/** :z 后缀区分数据结构 —— 与旧的标量/SET 版本共存时不会撞 WRONGTYPE。 */
const connKey = (userId: string): string => `chat:conn:z:${userId}`;
const onlineKey = (conversationId: string): string =>
  `chat:online:z:${conversationId}`;

@Injectable()
export class ChatPresenceRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(ChatPresenceRegistry.name);
  /** 本实例在线用户 → 其连接租约 id 与会话集合(续期与断连清理的依据)。 */
  private readonly localUsers = new Map<
    string,
    { leases: Set<string>; conversations: Set<string> }
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
   * 连接建立第一步:登记一条连接租约,返回该用户的全局连接数(上限判据)。
   *
   * leaseId 用 socket.id —— 断开时按它精确摘除。null = Redis 不可用
   * (未配置,或这一刻连不上/命令失败),调用方回退本实例计数;超限时调用方
   * 要调 socketDisconnected 把这条租约撤回去。
   */
  async registerSocket(
    userId: string,
    leaseId: string,
  ): Promise<number | null> {
    const local = this.localUsers.get(userId) ?? {
      leases: new Set<string>(),
      conversations: new Set<string>(),
    };
    local.leases.add(leaseId);
    this.localUsers.set(userId, local);
    if (!this.redis.isEnabled()) return null;
    const added = await this.redis.addToExpiringSet(
      connKey(userId),
      leaseId,
      KEY_TTL_SECONDS,
    );
    if (added === null) return null;
    const live = await this.redis.getLiveSetMembers(connKey(userId));
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
  async socketDisconnected(userId: string, leaseId: string): Promise<void> {
    const local = this.localUsers.get(userId);
    if (local) {
      local.leases.delete(leaseId);
      if (local.leases.size === 0) this.localUsers.delete(userId);
    }
    if (!this.redis.isEnabled()) return;
    await this.redis.removeFromExpiringSet(connKey(userId), leaseId);
    const live = await this.redis.getLiveSetMembers(connKey(userId));
    // null = Redis 这一刻不可用:宁可留着在线条目(最坏少推几条离线通知),
    // 也不要在读失败时把人误判成离线。
    if (live === null || live.length > 0) return;
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
    const live = await this.redis.getLiveSetMembers(connKey(userId));
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

  /** 全局在线判定;null = Redis 不可用。 */
  async isOnline(userId: string): Promise<boolean | null> {
    if (!this.redis.isEnabled()) return null;
    const live = await this.redis.getLiveSetMembers(connKey(userId));
    return live === null ? null : live.length > 0;
  }

  private async refreshLocal(): Promise<void> {
    try {
      for (const [userId, local] of this.localUsers) {
        for (const leaseId of local.leases) {
          // ZADD 幂等,只抬**本实例这几条**的到期时刻 —— 崩溃实例留下的条目
          // 该到期照样到期。
          await this.redis.addToExpiringSet(
            connKey(userId),
            leaseId,
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
