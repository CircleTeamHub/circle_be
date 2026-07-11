import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Optional,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { RedisService } from 'src/redis/redis.service';
import {
  uploadMetrics,
  type UploadPresignLimitStore,
} from 'src/metrics/upload-metrics';
import { PresignDto } from './dto/presign.dto';
import { UploadService } from './upload.service';

@ApiTags('upload')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('upload')
export class UploadController {
  /**
   * Per-user presign rate limit: max 20 requests per minute.
   * Keyed by userId so distributed users don't share quota,
   * and a stolen token can't spam the bucket at full global speed.
   */
  private readonly userPresignCounts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private static readonly PRESIGN_LIMIT = 20;
  private static readonly PRESIGN_WINDOW_MS = 60_000;
  private static readonly PRESIGN_WINDOW_SECONDS =
    UploadController.PRESIGN_WINDOW_MS / 1000;
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
    private readonly uploadService: UploadService,
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: RedisService,
  ) {}

  @Post('presign')
  @ApiOperation({
    summary: '获取预签名上传 URL',
    description:
      '返回 uploadUrl（PUT 文件用，5 分钟有效）和 fileUrl（上传后的永久访问地址）',
  })
  async presign(@Body() dto: PresignDto, @Req() req: RequestWithUser) {
    await this.checkUserPresignLimit(req.user.userId, dto.sizeBytes);
    // Pass userId for user-scoped folders so keys are namespaced per user,
    // enabling server-side ownership verification at upload time.
    const startedAt = process.hrtime.bigint();
    try {
      const result = await this.uploadService.presign(
        dto.filename,
        dto.contentType,
        dto.sizeBytes,
        dto.folder ?? 'avatars',
        req.user.userId,
      );
      uploadMetrics.observePresign(
        'success',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
        dto.sizeBytes,
      );
      return result;
    } catch (error) {
      uploadMetrics.observePresign(
        'failure',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
        dto.sizeBytes,
      );
      throw error;
    }
  }

  /**
   * Drop expired entries so the counter Map can't grow unbounded (one entry
   * per user that ever uploaded). Amortized — runs at most once per window.
   */
  private sweepExpiredPresignCounts(now: number): void {
    if (now - this.lastSweepAt < UploadController.PRESIGN_WINDOW_MS) {
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

  private async checkUserPresignLimit(
    userId: string,
    sizeBytes: number,
  ): Promise<void> {
    if (this.redisService?.isEnabled()) {
      const now = Date.now();
      if (now < this.redisRetryAt || this.redisProbeInFlight) {
        this.checkInMemoryPresignLimit(userId, sizeBytes);
        return;
      }
      if (this.redisInFlight >= UploadController.MAX_REDIS_IN_FLIGHT) {
        throw this.tooManyPresignRequests('bulkhead');
      }
      const probingRecovery = this.redisRetryAt > 0;
      if (probingRecovery) this.redisProbeInFlight = true;
      let count: number | null = null;
      let issuedBytes: number | null = null;
      try {
        this.redisInFlight += 1;
        count = await this.redisService.incrementWithTtl(
          `rl:upload-presign:user:${userId}`,
          UploadController.PRESIGN_WINDOW_SECONDS,
        );
        if (count !== null && count <= UploadController.PRESIGN_LIMIT) {
          issuedBytes = await this.redisService.incrementWithTtl(
            `rl:upload-presign-bytes:user:${userId}`,
            UploadController.DAILY_WINDOW_SECONDS,
            sizeBytes,
          );
        }
      } catch {
        count = null;
      } finally {
        this.redisInFlight -= 1;
        if (probingRecovery) this.redisProbeInFlight = false;
      }
      if (count !== null) {
        this.redisRetryAt = 0;
        if (count > UploadController.PRESIGN_LIMIT) {
          throw this.tooManyPresignRequests('redis');
        }
        if (issuedBytes !== null) {
          if (issuedBytes > UploadController.DAILY_ISSUED_BYTES_LIMIT) {
            throw this.tooManyPresignRequests('redis');
          }
          return;
        }
      }
      this.redisRetryAt = Date.now() + UploadController.REDIS_RETRY_COOLDOWN_MS;
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
        resetAt: now + UploadController.PRESIGN_WINDOW_MS,
      });
    } else {
      if (entry.count >= UploadController.PRESIGN_LIMIT) {
        throw this.tooManyPresignRequests('memory');
      }

      entry.count += 1;
    }

    const issued = this.userIssuedBytes.get(userId);
    if (!issued || now >= issued.resetAt) {
      this.userIssuedBytes.set(userId, {
        bytes: sizeBytes,
        resetAt: now + UploadController.DAILY_WINDOW_SECONDS * 1000,
      });
      return;
    }
    if (issued.bytes + sizeBytes > UploadController.DAILY_ISSUED_BYTES_LIMIT) {
      throw this.tooManyPresignRequests('memory');
    }
    issued.bytes += sizeBytes;
  }

  private tooManyPresignRequests(
    store: UploadPresignLimitStore,
  ): HttpException {
    uploadMetrics.recordPresignLimited(store);
    return new HttpException(
      'Too many upload requests. Please wait before requesting more upload URLs.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
