import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import { RedisService } from 'src/redis/redis.service';

/**
 * 访客上传的累计字节配额。
 *
 * 单看每分钟 10 次 × 10 MiB 仍是 100 MiB/min 的持续申请面,而访客凭证是匿名的、
 * 只要房间没结束就一直有效 —— 所以在「次数限流(@Throttle)」之外再加一道
 * 累计字节闸:按访客、按房间各记一份,任一超限就拒发新授权。
 *
 * 有 Redis 走 Redis(多实例共享);Redis 未配置或临时故障时退回单实例内存计数
 * —— 与 UploadController 的降级取舍一致:宁可配额只在本实例生效,也不因为
 * 计数层不可用就把发图整条打死。
 */
@Injectable()
export class TempChatUploadQuota {
  private readonly logger = new Logger(TempChatUploadQuota.name);

  /** 单个访客在房间生命周期内可申请的累计字节数。 */
  static readonly GUEST_BYTES_LIMIT = 60 * 1024 * 1024;
  /** 单个房间(全部访客合计)的累计字节数。 */
  static readonly ROOM_BYTES_LIMIT = 512 * 1024 * 1024;
  /** 计数窗口:与临时房最长存活时间同量级,窗口内不重置。 */
  static readonly WINDOW_SECONDS = 24 * 60 * 60;

  private readonly counters = new Map<
    string,
    { bytes: number; resetAt: number }
  >();
  private lastSweepAt = 0;

  constructor(
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: RedisService,
  ) {}

  /** 记账并在超限时抛 429;调用发生在发放 presign 之前。 */
  async consume(
    guestId: string,
    tcId: string,
    sizeBytes: number,
  ): Promise<void> {
    const buckets: Array<{ key: string; limit: number }> = [
      {
        key: `tc-upload-bytes:guest:${guestId}`,
        limit: TempChatUploadQuota.GUEST_BYTES_LIMIT,
      },
      {
        key: `tc-upload-bytes:room:${tcId}`,
        limit: TempChatUploadQuota.ROOM_BYTES_LIMIT,
      },
    ];
    for (const bucket of buckets) {
      const total = await this.increment(bucket.key, sizeBytes);
      if (total > bucket.limit) throw this.quotaExceeded();
    }
  }

  /** 返回累计值;Redis 不可用时用内存计数,两条路径语义一致。 */
  private async increment(key: string, sizeBytes: number): Promise<number> {
    if (this.redisService?.isEnabled()) {
      try {
        const total = await this.redisService.incrementWithTtl(
          key,
          TempChatUploadQuota.WINDOW_SECONDS,
          sizeBytes,
        );
        if (total !== null) return total;
      } catch (error) {
        this.logger.warn(
          `redis quota unavailable, falling back to in-memory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.incrementInMemory(key, sizeBytes);
  }

  private incrementInMemory(key: string, sizeBytes: number): number {
    const now = Date.now();
    this.sweep(now);
    const entry = this.counters.get(key);
    if (!entry || now >= entry.resetAt) {
      this.counters.set(key, {
        bytes: sizeBytes,
        resetAt: now + TempChatUploadQuota.WINDOW_SECONDS * 1000,
      });
      return sizeBytes;
    }
    entry.bytes += sizeBytes;
    return entry.bytes;
  }

  /** 定期清过期条目,避免 Map 随访客数无界增长。 */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    for (const [key, entry] of this.counters) {
      if (now >= entry.resetAt) this.counters.delete(key);
    }
  }

  private quotaExceeded(): HttpException {
    return new HttpException(
      {
        message: '上传额度已用尽,请稍后再试',
        errorCode: TempChatErrorCode.UploadQuotaExceeded,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
