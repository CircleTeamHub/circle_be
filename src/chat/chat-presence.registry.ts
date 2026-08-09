import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

/**
 * G-04/G-06:跨实例在线注册表。
 *
 * - `chat:conn:{userId}`   全局连接计数(多端/多实例求和),兼做连接数上限判据
 * - `chat:online:{convId}` 会话在线成员集合(推送分流 / 在线判定用)
 *
 * Redis 未配置时所有读方法返回 null,调用方回退单实例 fetchSockets 语义。
 * 崩溃自愈:所有 key 带 TTL,本实例每 REFRESH_MS 给自己的在线用户续期;
 * 实例崩掉不再续期,幽灵条目最迟 TTL 到期消失(期间的代价只是少推了几条离线推送)。
 */
const KEY_TTL_SECONDS = 90 * 60;
const REFRESH_MS = 20 * 60 * 1000;

const connKey = (userId: string): string => `chat:conn:${userId}`;
const onlineKey = (conversationId: string): string =>
  `chat:online:${conversationId}`;

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
   * null = Redis 不可用,调用方回退本实例计数;超限时调用方要调
   * socketDisconnected 把这一次 +1 退回去。
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
      await this.redis.addToSet(onlineKey(id), userId, KEY_TTL_SECONDS);
    }
  }

  /** 连接断开:全局计数 -1;归零才从各会话集合摘除(多端/多实例并存)。 */
  async socketDisconnected(userId: string): Promise<void> {
    const local = this.localUsers.get(userId);
    if (local) {
      local.sockets -= 1;
      if (local.sockets <= 0) this.localUsers.delete(userId);
    }
    if (!this.redis.isEnabled()) return;
    const remaining = await this.redis.decrementFloorZero(connKey(userId));
    if (remaining !== 0) return;
    const conversations = local?.conversations ?? new Set<string>();
    for (const id of conversations) {
      await this.redis.removeFromSet(onlineKey(id), userId);
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
      await this.redis.addToSet(
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
    await this.redis.removeFromSet(onlineKey(conversationId), userId);
  }

  /** 会话在线成员;null = Redis 不可用(调用方回退 fetchSockets)。 */
  async getOnlineUserIds(conversationId: string): Promise<string[] | null> {
    if (!this.redis.isEnabled()) return null;
    return this.redis.getSetMembers(onlineKey(conversationId));
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
          // SADD 幂等,顺带把集合 TTL 一起续上。
          await this.redis.addToSet(onlineKey(id), userId, KEY_TTL_SECONDS);
        }
      }
    } catch (error) {
      this.logger.warn(
        `presence refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
