import {
  Body,
  Controller,
  Delete,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHash } from 'crypto';
import { RedisService } from 'src/redis/redis.service';
import { RevokePushTokenDto } from './notification.dto';
import { NotificationService } from './notification.service';

@ApiTags('notification')
@Controller('notification')
export class NotificationPublicController {
  private static readonly REVOKE_LIMIT = 10;
  private static readonly REVOKE_WINDOW_MS = 60_000;
  private static readonly REVOKE_WINDOW_SECONDS = 60;
  private static readonly MAX_LOCAL_BUCKETS = 10_000;
  private readonly localRevokeCounts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private lastSweepAt = 0;

  constructor(
    private readonly notificationService: NotificationService,
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: RedisService,
  ) {}

  @Delete('push-token/revoke')
  @ApiOperation({ summary: 'Revoke a device push token with its secret' })
  async revokePushToken(@Body() dto: RevokePushTokenDto) {
    await this.checkTokenRevokeLimit(dto.token);
    return this.notificationService.revokePushToken(dto);
  }

  private async checkTokenRevokeLimit(token: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (this.redisService?.isEnabled()) {
      const count = await this.redisService.incrementWithTtl(
        `rl:push-token-revoke:token:${tokenHash}`,
        NotificationPublicController.REVOKE_WINDOW_SECONDS,
      );
      if (count !== null) {
        if (count > NotificationPublicController.REVOKE_LIMIT) {
          throw this.tooManyRevokeRequests();
        }
        return;
      }
    }
    this.checkLocalRevokeLimit(tokenHash);
  }

  private checkLocalRevokeLimit(tokenHash: string): void {
    const now = Date.now();
    this.sweepExpiredLocalCounts(now);
    const entry = this.localRevokeCounts.get(tokenHash);
    if (!entry || now >= entry.resetAt) {
      if (
        !entry &&
        this.localRevokeCounts.size >=
          NotificationPublicController.MAX_LOCAL_BUCKETS
      ) {
        const oldestKey = this.localRevokeCounts.keys().next().value as
          | string
          | undefined;
        if (oldestKey) this.localRevokeCounts.delete(oldestKey);
      }
      this.localRevokeCounts.set(tokenHash, {
        count: 1,
        resetAt: now + NotificationPublicController.REVOKE_WINDOW_MS,
      });
      return;
    }
    if (entry.count >= NotificationPublicController.REVOKE_LIMIT) {
      throw this.tooManyRevokeRequests();
    }
    entry.count += 1;
  }

  private sweepExpiredLocalCounts(now: number): void {
    if (
      now - this.lastSweepAt <
      NotificationPublicController.REVOKE_WINDOW_MS
    ) {
      return;
    }
    this.lastSweepAt = now;
    for (const [tokenHash, entry] of this.localRevokeCounts) {
      if (now >= entry.resetAt) this.localRevokeCounts.delete(tokenHash);
    }
  }

  private tooManyRevokeRequests(): HttpException {
    return new HttpException(
      'Too many push token revocation requests',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
