import {
  Body,
  Controller,
  Delete,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
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
  async revokePushToken(
    @Body() dto: RevokePushTokenDto,
    @Ip() ip: string,
  ): Promise<void> {
    const revoked = await this.notificationService.revokePushToken(dto);
    if (!revoked) {
      await this.checkTokenRevokeLimit(ip);
    }
  }

  /**
   * 这道限流挡的是「猜 token + secret 组合」的暴力扫描（只在撤销失败时计数）。
   *
   * 键必须是调用方的 IP，不能是 dto.token —— token 完全由攻击者提供，按它计数等于
   * 每换一个 token 就开一个新桶，扫描永远撞不到上限，限流形同虚设。这个接口没有
   * 鉴权，IP 是唯一稳定的调用方标识。
   *
   * 生产环境在 Caddy 后面，setup.ts 里设了 `trust proxy 1`，所以 @Ip() 拿到的是
   * 转发过来的真实客户端 IP 而不是网关地址。
   */
  private async checkTokenRevokeLimit(ip: string): Promise<void> {
    // 仍然哈希：IP 是个人数据，不该以明文进 Redis 键或被日志顺带记走。
    const callerHash = createHash('sha256')
      .update(ip || 'unknown')
      .digest('hex');
    if (this.redisService?.isEnabled()) {
      const count = await this.redisService.incrementWithTtl(
        `rl:push-token-revoke:ip:${callerHash}`,
        NotificationPublicController.REVOKE_WINDOW_SECONDS,
      );
      if (count !== null) {
        if (count > NotificationPublicController.REVOKE_LIMIT) {
          throw this.tooManyRevokeRequests();
        }
        return;
      }
    }
    this.checkLocalRevokeLimit(callerHash);
  }

  private checkLocalRevokeLimit(callerHash: string): void {
    const now = Date.now();
    this.sweepExpiredLocalCounts(now);
    const entry = this.localRevokeCounts.get(callerHash);
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
      this.localRevokeCounts.set(callerHash, {
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
    for (const [key, entry] of this.localRevokeCounts) {
      if (now >= entry.resetAt) this.localRevokeCounts.delete(key);
    }
  }

  private tooManyRevokeRequests(): HttpException {
    return new HttpException(
      'Too many push token revocation requests',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
