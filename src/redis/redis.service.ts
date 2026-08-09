import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Store } from 'express-rate-limit';
import { getServerConfig } from 'src/config/server.config';
import { FallbackRateLimitStore } from './fallback-rate-limit-store';
import {
  redisMetrics,
  type RedisCommandOperation,
  type RedisFailureReason,
} from './redis.metrics';

type RedisMessageHandler = (
  channel: string,
  message: string,
) => void | Promise<void>;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private static readonly CONNECT_TIMEOUT_MS = 2_000;
  private static readonly COMMAND_TIMEOUT_MS = 1_000;
  private static readonly CONNECT_FAILURE_COOLDOWN_MS = 2_000;
  private static readonly VERSION_FENCE_TTL_SECONDS = 24 * 60 * 60;

  private readonly logger = new Logger(RedisService.name);
  private readonly redisUrl: string;
  private readonly redisRequired: boolean;
  private commandClient: Redis | null = null;
  /** Shared in-flight connect, so concurrent callers don't race competing connects. */
  private connectingPromise: Promise<Redis | null> | null = null;
  /** Epoch ms before which we skip reconnect attempts (post-failure cooldown). */
  private nextConnectAttemptAt = 0;
  private readonly subscriberClients = new Set<Redis>();

  constructor() {
    const config = getServerConfig();
    this.redisUrl = String(
      process.env.REDIS_URL ?? config['REDIS_URL'] ?? '',
    ).trim();
    this.redisRequired = this.readBoolean(
      process.env.REDIS_REQUIRED ?? config['REDIS_REQUIRED'],
    );
  }

  isEnabled(): boolean {
    return this.redisUrl.length > 0;
  }

  async onModuleInit(): Promise<void> {
    if (!this.isEnabled()) {
      if (this.redisRequired) {
        throw new Error('REDIS_URL is required when REDIS_REQUIRED=true');
      }
      if (process.env.NODE_ENV !== 'production') return;
      this.logger.warn(
        'REDIS_URL is not configured in production; continuing with per-instance realtime and rate limiting.',
      );
      return;
    }
    if (process.env.NODE_ENV !== 'production' && !this.redisRequired) return;

    const client = await this.getCommandClient();
    if (!client) {
      this.handleStartupUnavailable(
        'Redis is unavailable during production startup',
      );
      return;
    }

    try {
      const reply = await client.ping();
      if (reply !== 'PONG') {
        throw new Error(`unexpected PING response: ${reply}`);
      }
    } catch (error) {
      this.recordCommandFailure('connect', error);
      this.handleStartupUnavailable(
        `Redis is unavailable during production startup: ${this.formatError(error)}`,
      );
    }
  }

  /**
   * Round-trips a PING. Reports Redis reachability for the readiness probe —
   * never throws, and returns false rather than waiting on an outage (the
   * client's connect/command timeouts and post-failure cooldown bound this).
   */
  async ping(): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('connect');
      return false;
    }

    try {
      return (await client.ping()) === 'PONG';
    } catch (error) {
      this.recordCommandFailure('connect', error);
      return false;
    }
  }

  async publish(channel: string, message: string): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('publish');
      return false;
    }

    try {
      await client.publish(channel, message);
      return true;
    } catch (error) {
      this.recordCommandFailure('publish', error);
      this.logger.warn(
        `Redis publish failed for ${channel}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('get');
      return null;
    }

    try {
      const value = await client.get(key);
      if (!value) {
        return null;
      }
      return JSON.parse(value) as T;
    } catch (error) {
      this.recordCommandFailure('get', error);
      this.logger.warn(
        `Redis JSON get failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  async getJsonMany<T>(keys: string[]): Promise<Array<T | null>> {
    if (keys.length === 0) return [];

    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('get');
      return keys.map(() => null);
    }

    try {
      const values = await client.mget(...keys);
      return values.map((value, index) => {
        if (!value) return null;
        try {
          return JSON.parse(value) as T;
        } catch (error) {
          this.logger.warn(
            `Redis JSON get failed for ${keys[index]}: ${this.formatError(error)}`,
          );
          return null;
        }
      });
    } catch (error) {
      this.recordCommandFailure('get', error);
      this.logger.warn(`Redis JSON MGET failed: ${this.formatError(error)}`);
      return keys.map(() => null);
    }
  }

  async setJson<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('set');
      return false;
    }

    try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    } catch (error) {
      this.recordCommandFailure('set', error);
      this.logger.warn(
        `Redis JSON set failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  /**
   * Atomically stores the greatest numeric value seen for a key.
   * A smaller late write succeeds without replacing the stronger marker.
   */
  async setNumericMax(
    key: string,
    value: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('set');
      return false;
    }

    try {
      const result = await client.eval(
        [
          "local raw = redis.call('GET', KEYS[1])",
          'local current = raw and tonumber(raw) or nil',
          'local incoming = tonumber(ARGV[1])',
          'if current and current >= incoming then',
          "  redis.call('EXPIRE', KEYS[1], ARGV[2])",
          '  return 1',
          'end',
          "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])",
          'return 1',
        ].join('\n'),
        1,
        key,
        String(value),
        String(ttlSeconds),
      );
      return Number(result) === 1;
    } catch (error) {
      this.recordCommandFailure('set', error);
      this.logger.warn(
        `Redis numeric max set failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  /**
   * Versioned, race-safe cache write. Stores `{ __ver, payload }` and only
   * overwrites when the incoming `version` is >= the stored version (or the key
   * is absent), atomically via a Lua CAS. This makes read-through repopulation
   * safe under concurrency: a slow reader holding a pre-invalidation (older)
   * value can never clobber a fresher write. `version` should be a monotonic
   * stamp of the underlying data (e.g. row `updatedAt` epoch ms).
   */
  async setJsonIfNewer<T>(
    key: string,
    value: T,
    version: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('versioned_set');
      return false;
    }

    try {
      const envelope = JSON.stringify({ __ver: version, payload: value });
      const result = await client.eval(
        [
          "local raw = redis.call('GET', KEYS[1])",
          'local incoming = tonumber(ARGV[2])',
          'if raw then',
          '  local ok, decoded = pcall(cjson.decode, raw)',
          '  if ok and type(decoded) == "table" and tonumber(decoded.__ver) ' +
            'and tonumber(decoded.__ver) >= incoming then',
          '    return 0',
          '  end',
          'end',
          "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
          'return 1',
        ].join('\n'),
        1,
        key,
        envelope,
        String(version),
        String(ttlSeconds),
      );
      return Number(result) === 1;
    } catch (error) {
      this.recordCommandFailure('versioned_set', error);
      this.logger.warn(
        `Redis versioned set failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  /** Reads a value written by {@link setJsonIfNewer}, unwrapping the version envelope. */
  async getJsonWithVersion<T>(
    key: string,
  ): Promise<{ version: number; payload: T } | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('versioned_get');
      return null;
    }

    try {
      const value = await client.get(key);
      if (!value) {
        return null;
      }
      const envelope = JSON.parse(value) as { __ver?: number; payload?: T };
      if (typeof envelope.__ver !== 'number' || !('payload' in envelope)) {
        return null;
      }
      return { version: envelope.__ver, payload: envelope.payload as T };
    } catch (error) {
      this.recordCommandFailure('versioned_get', error);
      this.logger.warn(
        `Redis versioned get failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  async getVersion(key: string): Promise<string | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('versioned_get');
      return null;
    }

    try {
      const value = await client.eval(
        [
          "local current = redis.call('GET', KEYS[1])",
          'if current then',
          "  redis.call('EXPIRE', KEYS[1], ARGV[2])",
          '  return current',
          'end',
          "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')",
          "return redis.call('GET', KEYS[1])",
        ].join('\n'),
        1,
        key,
        randomUUID(),
        String(RedisService.VERSION_FENCE_TTL_SECONDS),
      );
      return typeof value === 'string' ? value : String(value);
    } catch (error) {
      this.recordCommandFailure('versioned_get', error);
      this.logger.warn(
        `Redis version get failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  async setJsonIfVersionMatches<T>(
    key: string,
    versionKey: string,
    expectedVersion: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('versioned_set');
      return false;
    }

    try {
      const result = await client.eval(
        [
          "local current = redis.call('GET', KEYS[2]) or ''",
          'if current ~= ARGV[2] then return 0 end',
          "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
          'return 1',
        ].join('\n'),
        2,
        key,
        versionKey,
        JSON.stringify(value),
        String(expectedVersion),
        String(ttlSeconds),
      );
      return Number(result) === 1;
    } catch (error) {
      this.recordCommandFailure('versioned_set', error);
      this.logger.warn(
        `Redis fenced set failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async invalidateVersionedKey(
    key: string,
    versionKey: string,
  ): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('delete');
      return false;
    }

    try {
      await client.eval(
        [
          "redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])",
          "redis.call('DEL', KEYS[1])",
          'return 1',
        ].join('\n'),
        2,
        key,
        versionKey,
        randomUUID(),
        String(RedisService.VERSION_FENCE_TTL_SECONDS),
      );
      return true;
    } catch (error) {
      this.recordCommandFailure('delete', error);
      this.logger.warn(
        `Redis fenced invalidation failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async deleteKey(key: string): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('delete');
      return false;
    }

    try {
      return (await client.del(key)) > 0;
    } catch (error) {
      this.recordCommandFailure('delete', error);
      this.logger.warn(
        `Redis delete failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async incrementWithTtl(
    key: string,
    ttlSeconds: number,
    amount = 1,
  ): Promise<number | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('increment');
      return null;
    }

    try {
      const value = await client.eval(
        [
          "local current = redis.call('INCRBY', KEYS[1], ARGV[2])",
          'if current == tonumber(ARGV[2]) then',
          "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
          'end',
          'return current',
        ].join('\n'),
        1,
        key,
        String(ttlSeconds),
        String(amount),
      );
      return typeof value === 'number' ? value : Number(value);
    } catch (error) {
      this.recordCommandFailure('increment', error);
      this.logger.warn(
        `Redis increment failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  async subscribePattern(
    pattern: string,
    handler: RedisMessageHandler,
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    const subscriber = this.createClient();
    try {
      await subscriber.connect();
      await subscriber.psubscribe(pattern);
      subscriber.on('pmessage', (_pattern, channel, message) => {
        void Promise.resolve(handler(channel, message)).catch((error) => {
          this.logger.warn(
            `Redis message handler failed for ${channel}: ${this.formatError(error)}`,
          );
        });
      });
      this.subscriberClients.add(subscriber);
      return true;
    } catch (error) {
      this.recordCommandFailure('subscribe', error);
      this.logger.warn(
        `Redis subscription failed for ${pattern}: ${this.formatError(error)}`,
      );
      subscriber.disconnect();
      return false;
    }
  }

  /**
   * 供 socket.io redis-adapter 用的 pub/sub 客户端对(G-04 多实例广播)。
   * pub 复用命令连接;sub 独立连接并纳入销毁清理。Redis 未配置/连不上返回 null,
   * 调用方保持单实例语义。
   */
  async getAdapterClients(): Promise<{ pub: Redis; sub: Redis } | null> {
    const pub = await this.getCommandClient();
    if (!pub) return null;
    const sub = this.createClient();
    try {
      await sub.connect();
      this.subscriberClients.add(sub);
      return { pub, sub };
    } catch (error) {
      this.recordCommandFailure('subscribe', error);
      this.logger.warn(`Redis adapter sub failed: ${this.formatError(error)}`);
      sub.disconnect();
      return null;
    }
  }

  /**
   * 跨实例滑动窗口限流(ZSET + Lua 原子)。true=放行,false=超限,
   * null=Redis 不可用(调用方回退每实例本地限流)。
   */
  async slidingWindowAcquire(
    key: string,
    limit: number,
    windowMs: number,
    member: string,
  ): Promise<boolean | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('increment');
      return null;
    }
    try {
      const verdict = await client.eval(
        [
          "redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))",
          "if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end",
          "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])",
          "redis.call('PEXPIRE', KEYS[1], ARGV[2])",
          'return 1',
        ].join('\n'),
        1,
        key,
        String(Date.now()),
        String(windowMs),
        String(limit),
        member,
      );
      return Number(verdict) === 1;
    } catch (error) {
      this.recordCommandFailure('increment', error);
      this.logger.warn(
        `Redis sliding window failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  /** DECR 但不落到负数(计数器成对使用时防崩溃期错配)。null=不可用。 */
  async decrementFloorZero(key: string): Promise<number | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('increment');
      return null;
    }
    try {
      const value = await client.eval(
        [
          "local v = redis.call('DECR', KEYS[1])",
          "if v < 0 then redis.call('SET', KEYS[1], '0') return 0 end",
          'return v',
        ].join('\n'),
        1,
        key,
      );
      return Number(value);
    } catch (error) {
      this.recordCommandFailure('increment', error);
      this.logger.warn(
        `Redis decrement failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  /** SADD + 续 TTL(集合级过期,崩溃遗留的幽灵成员随 key 一起过期自愈)。 */
  async addToSet(
    key: string,
    member: string,
    ttlSeconds: number,
  ): Promise<boolean | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('set');
      return null;
    }
    try {
      await client.sadd(key, member);
      await client.expire(key, ttlSeconds);
      return true;
    } catch (error) {
      this.recordCommandFailure('set', error);
      return null;
    }
  }

  async removeFromSet(key: string, member: string): Promise<boolean | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('set');
      return null;
    }
    try {
      await client.srem(key, member);
      return true;
    } catch (error) {
      this.recordCommandFailure('set', error);
      return null;
    }
  }

  async getSetMembers(key: string): Promise<string[] | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('get');
      return null;
    }
    try {
      return await client.smembers(key);
    } catch (error) {
      this.recordCommandFailure('get', error);
      return null;
    }
  }

  /** 只续期不改值(在线注册表的定时自愈)。 */
  async touchTtl(key: string, ttlSeconds: number): Promise<boolean | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('set');
      return null;
    }
    try {
      await client.expire(key, ttlSeconds);
      return true;
    } catch (error) {
      this.recordCommandFailure('set', error);
      return null;
    }
  }

  /** 读普通计数键(chat:conn:* 在线连接数);key 不存在返回 0。null=不可用。 */
  async getCounter(key: string): Promise<number | null> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('get');
      return null;
    }
    try {
      const raw = await client.get(key);
      return raw === null ? 0 : Number(raw);
    } catch (error) {
      this.recordCommandFailure('get', error);
      return null;
    }
  }

  createRateLimitStore(limiterName: string): Store | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }

    const redisStore = new RedisStore({
      prefix: `rl:${limiterName}:`,
      sendCommand: async (command: string, ...args: string[]) =>
        this.sendCommand(command, ...args),
    });

    // Wrap so a Redis outage degrades to per-instance in-memory limiting
    // instead of silently disabling the limiter (see FallbackRateLimitStore).
    return new FallbackRateLimitStore(redisStore, limiterName, this.logger);
  }

  async onModuleDestroy() {
    const clients = [
      this.commandClient,
      ...Array.from(this.subscriberClients.values()),
    ].filter((client): client is Redis => client !== null);

    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );

    this.commandClient = null;
    this.connectingPromise = null;
    this.subscriberClients.clear();
  }

  private async sendCommand(
    command: string,
    ...args: string[]
  ): Promise<RedisReply> {
    const client = await this.getCommandClient();
    if (!client) {
      this.recordUnavailable('rate_limit');
      throw new Error('Redis is not configured');
    }
    try {
      return (await client.call(command, ...args)) as RedisReply;
    } catch (error) {
      this.recordCommandFailure('rate_limit', error);
      throw error;
    }
  }

  private async getCommandClient(): Promise<Redis | null> {
    if (!this.isEnabled()) {
      return null;
    }

    if (!this.commandClient) {
      this.commandClient = this.createClient();
    }

    const status = this.commandClient.status;
    if (status === 'ready') {
      return this.commandClient;
    }

    // ioredis is already (re)establishing the link — never start a competing
    // connect(), which would throw "Redis is already connecting/connected".
    if (
      status === 'connect' ||
      status === 'connecting' ||
      status === 'reconnecting'
    ) {
      return this.commandClient;
    }

    // status is 'wait' | 'close' | 'end' → we must (re)initiate the connection.
    // Back off briefly after a failure so an outage doesn't pay a fresh connect
    // attempt on every single request (reconnect storm).
    if (Date.now() < this.nextConnectAttemptAt) {
      return null;
    }

    // Dedupe concurrent first-connect attempts onto a single in-flight promise.
    if (!this.connectingPromise) {
      this.connectingPromise = this.connectCommandClient();
    }
    return this.connectingPromise;
  }

  private async connectCommandClient(): Promise<Redis | null> {
    const client = this.commandClient;
    if (!client) {
      return null;
    }
    try {
      await client.connect();
      return client;
    } catch (error) {
      this.nextConnectAttemptAt =
        Date.now() + RedisService.CONNECT_FAILURE_COOLDOWN_MS;
      this.logger.warn(`Redis connection failed: ${this.formatError(error)}`);
      this.recordCommandFailure('connect', error);
      return null;
    } finally {
      this.connectingPromise = null;
    }
  }

  private createClient(): Redis {
    const client = new Redis(this.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: RedisService.CONNECT_TIMEOUT_MS,
      commandTimeout: RedisService.COMMAND_TIMEOUT_MS,
      retryStrategy: (times) => Math.min(times * 100, 1_000),
    });

    client.on('error', (error) => {
      this.logger.warn(`Redis client error: ${this.formatError(error)}`);
    });

    return client;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private handleStartupUnavailable(message: string): void {
    if (this.redisRequired) {
      throw new Error(message);
    }
    this.logger.warn(
      `${message}; continuing with per-instance fallback until Redis recovers.`,
    );
  }

  private readBoolean(value: unknown): boolean {
    return (
      value === true ||
      (typeof value === 'string' && value.toLowerCase() === 'true')
    );
  }

  private recordUnavailable(operation: RedisCommandOperation): void {
    if (this.isEnabled()) {
      redisMetrics.recordCommandFailure(operation, 'unavailable');
    }
  }

  private recordCommandFailure(
    operation: RedisCommandOperation,
    error: unknown,
  ): void {
    const message = this.formatError(error).toLowerCase();
    const reason: RedisFailureReason = message.includes('timed out')
      ? 'timeout'
      : 'error';
    redisMetrics.recordCommandFailure(operation, reason);
  }
}
