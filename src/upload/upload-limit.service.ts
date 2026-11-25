import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import {
  uploadMetrics,
  type UploadPresignLimitStore,
} from 'src/metrics/upload-metrics';

/** Shared per-user allowance for upload URLs and server-side media copies. */
@Injectable()
export class UploadLimitService {
  /**
   * Per-user presign rate limit: max 40 requests per minute.
   * Keyed by userId so distributed users don't share quota,
   * and a stolen token can't spam the bucket at full global speed.
   *
   * An image costs two presigns (the original plus its thumbnail) in chat and,
   * since note cover thumbnails, in notes too — so 40 is 20 images a minute.
   * People routinely add a dozen or more images while editing one note; at 20
   * the second batch of ten failed. DAILY_ISSUED_BYTES_LIMIT still caps volume.
   */
  private readonly userPresignCounts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private static readonly PRESIGN_LIMIT = 40;
  private static readonly PRESIGN_WINDOW_MS = 60_000;
  private static readonly PRESIGN_WINDOW_SECONDS =
    UploadLimitService.PRESIGN_WINDOW_MS / 1000;
  private static readonly REDIS_RETRY_COOLDOWN_MS = 2_000;
  private static readonly MAX_REDIS_IN_FLIGHT = 32;
  private static readonly DAILY_ISSUED_BYTES_LIMIT = 1024 * 1024 * 1024;
  private static readonly DAILY_WINDOW_SECONDS = 24 * 60 * 60;
  /** Timestamp of the last expired-entry sweep — bounds the Map's growth. */
  private lastSweepAt = 0;
  private redisRetryAt = 0;
  private redisProbeInFlight = false;
  private redisInFlight = 0;
  private readonly userIssuedBytes = new Map<
    string,
    { bytes: number; resetAt: number }
  >();

  constructor(
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: RedisService,
  ) {}

  /**
   * Drop expired entries so the counter Map can't grow unbounded (one entry
   * per user that ever uploaded). Amortized — runs at most once per window.
   */
  private sweepExpiredPresignCounts(now: number): void {
    if (now - this.lastSweepAt < UploadLimitService.PRESIGN_WINDOW_MS) {
      return;
    }
    this.lastSweepAt = now;
    for (const [userId, entry] of this.userPresignCounts) {
      if (now >= entry.resetAt) {
        this.userPresignCounts.delete(userId);
      }
    }
    for (const [userId, entry] of this.userIssuedBytes) {
      if (now >= entry.resetAt) {
        this.userIssuedBytes.delete(userId);
      }
    }
  }

  async check(userId: string, sizeBytes: number): Promise<void> {
    if (this.redisService?.isEnabled()) {
      const now = Date.now();
      if (now < this.redisRetryAt || this.redisProbeInFlight) {
        this.checkInMemoryPresignLimit(userId, sizeBytes);
        return;
      }
      if (this.redisInFlight >= UploadLimitService.MAX_REDIS_IN_FLIGHT) {
        // 只是这一瞬间挤:让客户端一秒后再要。
        throw this.tooManyPresignRequests('bulkhead', 1);
      }
      const probingRecovery = this.redisRetryAt > 0;
      if (probingRecovery) this.redisProbeInFlight = true;
      const countKey = `rl:upload-presign:user:${userId}`;
      this.redisInFlight += 1;
      try {
        let count: number | null = null;
        let issuedBytes: number | null = null;
        try {
          count = await this.redisService.incrementWithTtl(
            countKey,
            UploadLimitService.PRESIGN_WINDOW_SECONDS,
          );
          if (count !== null && count <= UploadLimitService.PRESIGN_LIMIT) {
            issuedBytes = await this.redisService.incrementWithTtl(
              `rl:upload-presign-bytes:user:${userId}`,
              UploadLimitService.DAILY_WINDOW_SECONDS,
              sizeBytes,
            );
          }
        } catch {
          count = null;
        } finally {
          if (probingRecovery) this.redisProbeInFlight = false;
        }
        if (count !== null) {
          this.redisRetryAt = 0;
          if (count > UploadLimitService.PRESIGN_LIMIT) {
            // The counter proves recovery. Keep the slot for the TTL lookup
            // without changing recovery state after it completes.
            const retryAfterSeconds = await this.redisService
              .secondsUntilExpiry(countKey)
              .catch(() => null);
            throw this.tooManyPresignRequests(
              'redis',
              retryAfterSeconds ?? UploadLimitService.PRESIGN_WINDOW_SECONDS,
            );
          }
          if (issuedBytes !== null) {
            if (issuedBytes > UploadLimitService.DAILY_ISSUED_BYTES_LIMIT) {
              throw this.tooManyPresignRequests('redis');
            }
            return;
          }
        }
        this.redisRetryAt =
          Date.now() + UploadLimitService.REDIS_RETRY_COOLDOWN_MS;
      } finally {
        this.redisInFlight -= 1;
      }
      // Redis is configured but errored (null): degrade to per-instance
      // in-memory limiting instead of failing the upload (503). This keeps the
      // limiter active and never fully fails open, consistent with how the
      // express-rate-limit limiters fall back during a Redis outage.
    }

    this.checkInMemoryPresignLimit(userId, sizeBytes);
  }

  private checkInMemoryPresignLimit(userId: string, sizeBytes: number): void {
    const now = Date.now();
    this.sweepExpiredPresignCounts(now);
    const entry = this.userPresignCounts.get(userId);

    if (!entry || now >= entry.resetAt) {
      this.userPresignCounts.set(userId, {
        count: 1,
        resetAt: now + UploadLimitService.PRESIGN_WINDOW_MS,
      });
    } else {
      if (entry.count >= UploadLimitService.PRESIGN_LIMIT) {
        throw this.tooManyPresignRequests(
          'memory',
          Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
        );
      }

      entry.count += 1;
    }

    const issued = this.userIssuedBytes.get(userId);
    if (!issued || now >= issued.resetAt) {
      this.userIssuedBytes.set(userId, {
        bytes: sizeBytes,
        resetAt: now + UploadLimitService.DAILY_WINDOW_SECONDS * 1000,
      });
      return;
    }
    if (
      issued.bytes + sizeBytes >
      UploadLimitService.DAILY_ISSUED_BYTES_LIMIT
    ) {
      throw this.tooManyPresignRequests('memory');
    }
    issued.bytes += sizeBytes;
  }

  /**
   * retryAfterSeconds:按分钟的次数限流才给 —— 客户端等这么久再要就能过(一次选
   * 30 张图要 60 个凭证,超出的那部分等窗口过去,而不是直接失败)。每日流量额度用完
   * 时不给:等也没用,客户端应当照常报错。随响应体的 data 下发。
   */
  private tooManyPresignRequests(
    store: UploadPresignLimitStore,
    retryAfterSeconds?: number,
  ): HttpException {
    uploadMetrics.recordPresignLimited(store);
    const message =
      'Too many upload requests. Please wait before requesting more upload URLs.';
    return new HttpException(
      retryAfterSeconds === undefined
        ? message
        : { message, details: { retryAfterSeconds } },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
