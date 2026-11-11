import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { JobLeaseContext, runWithJobLease } from 'src/redis/job-lease';
import { RedisService } from 'src/redis/redis.service';
import { sanitizeLogValue } from 'src/logging/log-sanitizer';
import { attemptDiagnostic } from 'src/logging/http-failure.logger';
import { ChatMediaService } from './chat-media.service';
import {
  CHAT_MEDIA_RETENTION_DAYS,
  chatMediaRetentionCutoff,
} from './chat-media-retention';
import {
  expiredMediaCandidatesQuery,
  purgeExpiredMediaQuery,
} from './chat-media-retention.query';
import { CHAT_NOTE_IMPORT_SEGMENT } from './chat.constants';

const RETENTION_JOB = 'chat_media_retention';
const RETENTION_BATCH = 500;
/**
 * 一个事务里最多改几条:每条正文变更都触发 revision 递增、更新同一会话行,删除排队
 * 还要逐个 key 拿咨询锁。积压时同一会话一批可能几百条,整批一个事务会超出交互事务
 * 时限整批回滚(游标已越过,天天失败),期间还一直挡着这个会话的发消息。
 */
const RETENTION_TX_CHUNK = 50;
const RETENTION_LEASE_MS = 2 * 60_000;
/**
 * 单轮时间预算:首次上线或停摆多天后的积压分几天消化,不让一轮长时间占着热表。
 * 没清完的明天接着来 —— 读路径按年龄标「已过期」,清理晚几天用户看不出差别。
 */
const RETENTION_BUDGET_MS = 10 * 60_000;

type Candidate = { id: string; conversationID: string; createdAt: Date };
type PurgedRow = {
  id: string;
  key: string | null;
  thumbKey: string | null;
  coverKey: string | null;
};

/**
 * 每天把过了保留期(chat-media-retention)的聊天媒体清掉:正文换成「已过期」、
 * 旧对象进删除队列。删除队列自己会跳过仍被别的活消息、焚毁归档引用的对象,
 * 笔记导入的共享对象走引用计数释放。被收藏着的消息整条跳过。
 */
@Injectable()
export class ChatMediaRetentionService {
  private readonly logger = new Logger(ChatMediaRetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: ChatMediaService,
    private readonly redis: RedisService,
  ) {}

  @TrackedCron(CronExpression.EVERY_DAY_AT_5AM, 'chat_media_retention')
  async purge(): Promise<void> {
    if (this.running) {
      reportJobSkipped();
      return;
    }
    this.running = true;
    try {
      const ran = await runWithJobLease(
        this.redis,
        RETENTION_JOB,
        RETENTION_LEASE_MS,
        async (_token, lease) => {
          await this.purgeOnce(lease);
        },
      );
      // 别的实例正在清。
      if (!ran) reportJobSkipped();
    } finally {
      this.running = false;
    }
  }

  /** 返回本轮清掉的消息条数。 */
  async purgeOnce(lease: JobLeaseContext, now = Date.now()): Promise<number> {
    const deadline = Date.now() + RETENTION_BUDGET_MS;
    let purged = 0;
    try {
      for (const type of Object.keys(CHAT_MEDIA_RETENTION_DAYS)) {
        const cutoff = chatMediaRetentionCutoff(type, now);
        let after: Candidate | undefined;
        for (;;) {
          if (!lease.isCurrent() || Date.now() > deadline) {
            reportJobSkipped();
            return purged;
          }
          const rows = await this.prisma.$queryRaw<Candidate[]>(
            expiredMediaCandidatesQuery({
              type,
              cutoff,
              after,
              limit: RETENTION_BATCH,
            }),
          );
          if (rows.length === 0) break;
          after = rows[rows.length - 1];
          purged += await this.purgeBatch(rows, lease);
          if (rows.length < RETENTION_BATCH) break;
        }
      }
    } catch (error) {
      this.recordFailure('scan', error);
    } finally {
      if (purged > 0) {
        void this.media.drainPendingDeletions();
        this.logger.log(`expired media of ${purged} chat messages`);
      }
    }
    return purged;
  }

  private async purgeBatch(
    rows: Candidate[],
    lease: JobLeaseContext,
  ): Promise<number> {
    const byConversation = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byConversation.get(row.conversationID) ?? [];
      ids.push(row.id);
      byConversation.set(row.conversationID, ids);
    }
    let purged = 0;
    for (const [conversationId, ids] of byConversation) {
      for (let start = 0; start < ids.length; start += RETENTION_TX_CHUNK) {
        try {
          purged += await this.purgeConversation(
            conversationId,
            ids.slice(start, start + RETENTION_TX_CHUNK),
            lease,
          );
        } catch (error) {
          this.recordFailure('conversation', error, conversationId);
        }
      }
    }
    return purged;
  }

  private purgeConversation(
    conversationId: string,
    ids: string[],
    lease: JobLeaseContext,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      // 会话行锁先拿:正文变更触发 revision 递增并更新会话计数,与焚毁清扫同一锁序。
      await tx.$queryRaw`
        SELECT "id" FROM "ChatConversation"
        WHERE "id" = ${conversationId} FOR UPDATE`;
      if (!lease.isCurrent()) return 0;
      const rows = await tx.$queryRaw<PurgedRow[]>(purgeExpiredMediaQuery(ids));
      if (rows.length === 0) return 0;
      const keys = rows
        .flatMap((row) => [row.key, row.thumbKey, row.coverKey])
        .filter((key): key is string => typeof key === 'string');
      const isNoteImport = (key: string) =>
        key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`);
      await this.media.queueDeletions(
        tx,
        keys.filter((key) => !isNoteImport(key)),
      );
      await this.media.releaseNoteImportReferences(
        tx,
        rows.map((row) => row.id),
        keys.filter(isNoteImport),
      );
      return rows.length;
    });
  }

  private recordFailure(
    operation: 'scan' | 'conversation',
    error: unknown,
    conversationId?: string,
  ): void {
    reportHandledJobFailure();
    attemptDiagnostic(() =>
      this.logger.error(
        sanitizeLogValue({
          event: 'chat_media_retention_failed',
          operation,
          conversationId,
          error,
        }),
      ),
    );
  }
}
