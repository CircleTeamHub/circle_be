import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { SessionRevocationService } from 'src/auth/session-revocation.service';
import { PrismaService } from 'src/prisma/prisma.service';

const SESSION_REVOCATION_BATCH_SIZE = 100;
const SESSION_REVOCATION_MAX_BACKOFF_MS = 60 * 60 * 1000;
const SESSION_REVOCATION_CLAIM_LEASE_MS = 55 * 1000;
const REVOCATION_UNAVAILABLE =
  'Redis revocation or socket broadcast unavailable';

@Injectable()
export class SessionRevocationOutboxProcessor {
  private readonly logger = new Logger(SessionRevocationOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionRevocation: SessionRevocationService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'session_revocation_outbox')
  async processPending(): Promise<number> {
    const now = new Date();
    const jobs = await this.prisma.sessionRevocationOutbox.findMany({
      where: {
        OR: [{ nextAttemptAt: { lte: now } }, { expiresAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: SESSION_REVOCATION_BATCH_SIZE,
    });
    let completed = 0;

    for (const job of jobs) {
      if (job.expiresAt <= now) {
        const deleted = await this.prisma.sessionRevocationOutbox.deleteMany({
          where: { userID: job.userID, revokedAt: job.revokedAt },
        });
        completed += deleted.count;
        continue;
      }

      const claimedUntil = new Date(
        now.getTime() + SESSION_REVOCATION_CLAIM_LEASE_MS,
      );
      const claimed = await this.prisma.sessionRevocationOutbox.updateMany({
        where: {
          userID: job.userID,
          revokedAt: job.revokedAt,
          nextAttemptAt: job.nextAttemptAt,
          attempts: job.attempts,
        },
        data: { nextAttemptAt: claimedUntil },
      });
      if (claimed.count !== 1) {
        continue;
      }

      try {
        const revoked = await this.sessionRevocation.revokeUserAt(
          job.userID,
          job.revokedAt.getTime(),
        );
        if (!revoked) throw new Error(REVOCATION_UNAVAILABLE);

        const deleted = await this.prisma.sessionRevocationOutbox.deleteMany({
          where: { userID: job.userID, revokedAt: job.revokedAt },
        });
        completed += deleted.count;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.sessionRevocationOutbox.updateMany({
          where: {
            userID: job.userID,
            revokedAt: job.revokedAt,
            nextAttemptAt: claimedUntil,
          },
          data: {
            attempts: { increment: 1 },
            lastError: message.slice(0, 1000),
            nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          },
        });
        this.logger.warn({
          message: 'Session revocation retry failed',
          error: message,
          userID: job.userID,
          revokedAt: job.revokedAt.toISOString(),
          attempts: job.attempts + 1,
        });
        // 这一条撤销**没有生效**：会话还活着，登出/封禁/盗号撤销都没落地。
        // 异常在这里被吞掉后方法正常返回，包装器只看「有没有抛」的话会把这
        // 一轮记成功、心跳照常前进 —— Redis 或广播长时间不可用时
        // CronJobFailing 一路绿灯，而队列一条都没处理掉。
        //
        // 这里刻意不做「单项失败可以容忍」的区分（temp-chat 的单房 teardown
        // 就是那么处理的）：撤销失败的成因是 Redis / socket 广播不可用，是整条
        // 路径的故障而不是某一行的坏数据，而且它踩的是安全路径。CronJobFailing
        // 要 last_result 连续 15 分钟为 0 才响，下一分钟只要有一轮全成功就会
        // 翻回 1，单次抖动不会惊动人。
        reportHandledJobFailure();
      }
    }

    return completed;
  }

  private nextRetryAt(attempts: number): Date {
    const delayMs = Math.min(
      SESSION_REVOCATION_MAX_BACKOFF_MS,
      60_000 * 2 ** Math.max(0, attempts - 1),
    );
    return new Date(Date.now() + delayMs);
  }
}
