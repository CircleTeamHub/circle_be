import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { runWithJobLease } from 'src/redis/job-lease';
import {
  reportJobSkipped,
  TrackedCron,
} from 'src/metrics/tracked-cron.decorator';
import { ChatMediaService } from './chat-media.service';
import { CHAT_NOTE_IMPORT_SEGMENT } from './chat.constants';

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
          take: 200,
          select: { id: true, conversationID: true },
        });
        for (const item of due) {
          if (!lease.isCurrent()) return;
          await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id"=${item.conversationID} FOR UPDATE`;
            if (!lease.isCurrent()) return;
            const row = await tx.chatBurnArchive.findUnique({
              where: { id: item.id },
            });
            if (!row || row.retainUntil.getTime() > Date.now()) return;
            const content = row.content as Record<string, unknown>;
            const keys = ['key', 'thumbKey', 'coverKey']
              .map((field) => content[field])
              .filter((key): key is string => typeof key === 'string');
            const imports = keys.filter((key) =>
              key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`),
            );
            const owned = await this.media.unreferencedArchiveMedia(
              tx,
              keys,
              row.id,
            );
            await this.media.queueDeletions(tx, owned, row.id);
            await this.media.releaseNoteImportReferences(tx, [row.id], imports);
            await tx.e2eeArchive.deleteMany({
              where: { messageID: row.id, recovery: { purpose: 'AUDIT' } },
            });
            await tx.chatBurnArchive.delete({ where: { id: row.id } });
          });
        }
      },
    );
    if (!ran) {
      reportJobSkipped();
      return;
    }
    await this.media.drainPendingDeletions();
  }
}
