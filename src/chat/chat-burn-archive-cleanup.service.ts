import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { JobLeaseContext, runWithJobLease } from 'src/redis/job-lease';
import {
  reportJobSkipped,
  TrackedCron,
} from 'src/metrics/tracked-cron.decorator';
import { Prisma } from 'src/generated/prisma';
import { ChatMediaService } from './chat-media.service';
import {
  CHAT_MEDIA_KEY_FIELDS,
  CHAT_NOTE_IMPORT_SEGMENT,
} from './chat.constants';

/** 单轮扫描的到期归档上限。 */
const CLEANUP_SCAN_MAX = 200;
/**
 * 一个事务最多清理的归档行数。整个事务都持有会话行锁,同会话的发消息要排队等它;
 * 同一批焚毁出来的归档 retainUntil 挨在一起,不封顶的话一个事务就是一整轮。
 */
const CLEANUP_ROWS_PER_TX = 50;

type DueArchive = { id: string; conversationID: string };
type ArchiveRow = { id: string; type: string; content: Prisma.JsonValue };

/**
 * 到期归档按会话分组、每组按 CLEANUP_ROWS_PER_TX 切块,保持扫描顺序(组按首次
 * 出现的先后,组内按 retainUntil, id)。
 */
function groupByConversation(
  due: DueArchive[],
): Array<{ conversationID: string; ids: string[] }> {
  const groups = new Map<string, string[]>();
  for (const item of due) {
    const ids = groups.get(item.conversationID) ?? [];
    groups.set(item.conversationID, [...ids, item.id]);
  }
  return [...groups].flatMap(([conversationID, ids]) =>
    Array.from(
      { length: Math.ceil(ids.length / CLEANUP_ROWS_PER_TX) },
      (_, index) => ({
        conversationID,
        ids: ids.slice(
          index * CLEANUP_ROWS_PER_TX,
          (index + 1) * CLEANUP_ROWS_PER_TX,
        ),
      }),
    ),
  );
}

function archiveMediaKeys(row: ArchiveRow): string[] {
  const content = row.content as Record<string, unknown>;
  return (CHAT_MEDIA_KEY_FIELDS[row.type] ?? [])
    .map((field) => content[field.key])
    .filter((key): key is string => typeof key === 'string');
}

@Injectable()
export class ChatBurnArchiveCleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: ChatMediaService,
    private readonly redis: RedisService,
  ) {}
  @TrackedCron(CronExpression.EVERY_MINUTE, 'chat_burn_archive_cleanup')
  async sweep(): Promise<void> {
    const ran = await runWithJobLease(
      this.redis,
      'chat_burn_archive_cleanup',
      120_000,
      async (_token, lease) => {
        const due = await this.prisma.chatBurnArchive.findMany({
          where: { retainUntil: { lte: new Date() } },
          orderBy: [{ retainUntil: 'asc' }, { id: 'asc' }],
          take: CLEANUP_SCAN_MAX,
          select: { id: true, conversationID: true },
        });
        for (const batch of groupByConversation(due)) {
          if (!lease.isCurrent()) return;
          await this.prisma.$transaction((tx) =>
            this.cleanupBatch(tx, batch.conversationID, batch.ids, lease),
          );
        }
      },
    );
    if (!ran) {
      reportJobSkipped();
      return;
    }
    await this.media.drainPendingDeletions();
  }

  /**
   * 同一会话的一批到期归档:先锁会话行(与焚毁清扫、发送同一顺序),在锁下重读并
   * 复核到期,再按统一顺序一次拿齐整批附件 key 的 advisory 锁,最后逐行清理。
   */
  private async cleanupBatch(
    tx: Prisma.TransactionClient,
    conversationID: string,
    ids: string[],
    lease: JobLeaseContext,
  ): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id"=${conversationID} FOR UPDATE`;
    if (!lease.isCurrent()) return;
    const found = await tx.chatBurnArchive.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(found.map((row) => [row.id, row]));
    const expired = ids
      .map((id) => byId.get(id))
      .filter(
        (row): row is NonNullable<typeof row> =>
          row !== undefined && row.retainUntil.getTime() <= Date.now(),
      );
    if (expired.length === 0) return;
    // 逐行的 unreferencedArchiveMedia / releaseNoteImportReferences 各自按行加锁,
    // 一个事务里跨行的先后就不再有序;先按全局顺序锁齐(advisory 锁可重入)。
    await this.media.lockArchiveKeys(tx, expired.flatMap(archiveMediaKeys));
    for (const row of expired) {
      if (!lease.isCurrent()) return;
      await this.cleanupRow(tx, row);
    }
  }

  private async cleanupRow(
    tx: Prisma.TransactionClient,
    row: ArchiveRow,
  ): Promise<void> {
    const keys = archiveMediaKeys(row);
    const imports = keys.filter((key) =>
      key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`),
    );
    const owned = await this.media.unreferencedArchiveMedia(tx, keys, row.id);
    await this.media.queueDeletions(tx, owned, row.id);
    await this.media.releaseNoteImportReferences(tx, [row.id], imports);
    await tx.e2eeArchive.deleteMany({
      where: { messageID: row.id, recovery: { purpose: 'AUDIT' } },
    });
    await tx.chatBurnArchive.delete({ where: { id: row.id } });
  }
}
