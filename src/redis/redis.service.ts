import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getServerConfig } from 'src/config/server.config';

type RedisMessageHandler = (
  channel: string,
  message: string,
) => void | Promise<void>;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly redisUrl: string;
  private commandClient: Redis | null = null;
  private readonly subscriberClients = new Set<Redis>();

  constructor() {
    const config = getServerConfig();
    this.redisUrl = String(
      process.env.REDIS_URL ?? config['REDIS_URL'] ?? '',
    ).trim();
  }

  isEnabled(): boolean {
    return this.redisUrl.length > 0;
  }

  async publish(channel: string, message: string): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      return false;
    }

    try {
      await client.publish(channel, message);
      return true;
    } catch (error) {
      this.logger.warn(
        `Redis publish failed for ${channel}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const client = await this.getCommandClient();
    if (!client) {
      return null;
    }

    try {
      const value = await client.get(key);
      if (!value) {
        return null;
      }
      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.warn(
        `Redis JSON get failed for ${key}: ${this.formatError(error)}`,
      );
      return null;
    }
  }

  async setJson<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      return false;
    }

    try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    } catch (error) {
      this.logger.warn(
        `Redis JSON set failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async deleteKey(key: string): Promise<boolean> {
    const client = await this.getCommandClient();
    if (!client) {
      return false;
    }

    try {
      return (await client.del(key)) > 0;
    } catch (error) {
      this.logger.warn(
        `Redis delete failed for ${key}: ${this.formatError(error)}`,
      );
      return false;
    }
  }

  async incrementWithTtl(
    key: string,
    ttlSeconds: number,
  ): Promise<number | null> {
    const client = await this.getCommandClient();
    if (!client) {
      return null;
    }

    try {
      const value = await client.eval(
        [
          "local current = redis.call('INCR', KEYS[1])",
          'if current == 1 then',
          "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
          'end',
          'return current',
        ].join('\n'),
        1,
        key,
        String(ttlSeconds),
      );
      return typeof value === 'number' ? value : Number(value);
    } catch (error) {
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
      this.logger.warn(
        `Redis subscription failed for ${pattern}: ${this.formatError(error)}`,
      );
      subscriber.disconnect();
      return false;
    }
  }

  createRateLimitStore(limiterName: string): RedisStore | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }

    return new RedisStore({
      prefix: `rl:${limiterName}:`,
      sendCommand: async (command: string, ...args: string[]) =>
        this.sendCommand(command, ...args),
    });
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
    this.subscriberClients.clear();
  }

  private async sendCommand(
    command: string,
    ...args: string[]
  ): Promise<RedisReply> {
    const client = await this.getCommandClient();
    if (!client) {
      throw new Error('Redis is not configured');
    }

    return client.call(command, ...args) as Promise<RedisReply>;
  }

  private async getCommandClient(): Promise<Redis | null> {
    if (!this.isEnabled()) {
      return null;
    }

    if (!this.commandClient) {
      this.commandClient = this.createClient();
    }

    if (this.commandClient.status === 'ready') {
      return this.commandClient;
    }

    if (
      this.commandClient.status === 'connect' ||
      this.commandClient.status === 'connecting'
    ) {
      return this.commandClient;
    }

    try {
      await this.commandClient.connect();
      return this.commandClient;
    } catch (error) {
      this.logger.warn(`Redis connection failed: ${this.formatError(error)}`);
      return null;
    }
  }

  private createClient(): Redis {
    const client = new Redis(this.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
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
}
