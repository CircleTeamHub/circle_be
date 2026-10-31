import { Injectable, Logger, Optional } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { sanitizeLogValue } from 'src/logging/log-sanitizer';
import { TrackedCron } from 'src/metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { ASSISTANT_KEY } from 'src/assistant/assistant.constants';
import { AssistantService } from 'src/assistant/assistant.service';

const JOB_BATCH_SIZE = 20;
const RECIPIENT_PAGE_SIZE = 100;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

type FanoutJob = {
  rootNoteID: string;
  status: 'PENDING' | 'PROCESSING' | 'FAILED';
  stage: 'OWNERS' | 'CHAT_MEMBERS';
  generation: number;
  noteCursor: string | null;
  chatConversationCursor: string | null;
  chatUserCursor: string | null;
  attempts: number;
  lockedAt: Date | null;
  workStatusChanged: boolean;
};

type SourcePayload = {
  sourceNoteId: string;
  ownerID: string | null;
  title: string;
  workStatus: 'WORKING' | 'CLOSED' | null;
  status: 'ACTIVE' | 'UNLISTED' | 'DELETED';
  available: boolean;
  changedAt: string;
};

/** 只提醒开工/打烊的真实切换;上下架、删除只刷新名片。 */
function alertStatus(
  job: FanoutJob,
  payload: SourcePayload,
): 'CLOSED' | 'WORKING' | null {
  if (!job.workStatusChanged || payload.status === 'DELETED') return null;
  return payload.workStatus;
}

@Injectable()
export class NoteStatusFanoutOutboxProcessor {
  private readonly logger = new Logger(NoteStatusFanoutOutboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Optional() private readonly assistant?: AssistantService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'note_status_fanout_outbox')
  async processPending(): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const jobs = await this.prisma.noteStatusFanoutOutbox.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { queuedAt: 'asc' },
      take: JOB_BATCH_SIZE,
    });

    for (const job of jobs as FanoutJob[]) {
      await this.processJob(job);
    }
  }

  private async processJob(job: FanoutJob): Promise<void> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.noteStatusFanoutOutbox.updateMany({
      where: {
        rootNoteID: job.rootNoteID,
        generation: job.generation,
        status: job.status,
        ...(job.status === 'PROCESSING' ? { lockedAt: job.lockedAt } : {}),
      },
      data: {
        status: 'PROCESSING',
        leaseToken,
        lockedAt: new Date(),
      },
    });
    if (claimed.count === 0) return;

    try {
      const payload = await this.loadPayload(job.rootNoteID);
      if (job.stage === 'OWNERS') {
        await this.processOwnerPage(job, leaseToken, payload);
      } else {
        await this.processChatMemberPage(job, leaseToken, payload);
      }
    } catch (error) {
      const failed = await this.prisma.noteStatusFanoutOutbox.updateMany({
        where: this.claimedWhere(job, leaseToken),
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: this.errorCategory(error),
          nextAttemptAt: this.nextRetryAt(job.attempts + 1),
          lockedAt: null,
          leaseToken: null,
        },
      });
      // A newer note mutation deliberately invalidates the old generation.
      // Its replacement job owns delivery now, so do not emit a false alarm.
      if (failed.count === 0) return;
      this.logger.warn(
        sanitizeLogValue({
          event: 'note_status_fanout_failed',
          rootNoteID: job.rootNoteID,
          generation: job.generation,
          stage: job.stage,
          attempt: job.attempts + 1,
          error,
        }),
      );
      reportOperationalError(error, {
        component: 'NoteStatusFanoutOutboxProcessor',
        operation: 'processJob',
        kind: job.stage.toLowerCase(),
      });
    }
  }

  private async loadPayload(rootNoteID: string): Promise<SourcePayload> {
    const source = await this.prisma.note.findUnique({
      where: { id: rootNoteID },
      select: {
        id: true,
        ownerID: true,
        title: true,
        status: true,
        available: true,
        workStatus: true,
        updatedAt: true,
      },
    });
    return source
      ? {
          sourceNoteId: rootNoteID,
          ownerID: source.ownerID,
          title: typeof source.title === 'string' ? source.title : '',
          workStatus: source.workStatus,
          status: source.status,
          available: source.available,
          changedAt:
            source.updatedAt instanceof Date
              ? source.updatedAt.toISOString()
              : new Date().toISOString(),
        }
      : {
          sourceNoteId: rootNoteID,
          ownerID: null,
          title: '',
          workStatus: null,
          status: 'DELETED',
          available: false,
          changedAt: new Date().toISOString(),
        };
  }

  private async processOwnerPage(
    job: FanoutJob,
    leaseToken: string,
    payload: SourcePayload,
  ): Promise<void> {
    const rows = await this.prisma.note.findMany({
      where: {
        OR: [{ id: job.rootNoteID }, { rootSourceNoteID: job.rootNoteID }],
        ...(job.noteCursor ? { id: { gt: job.noteCursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: RECIPIENT_PAGE_SIZE + 1,
      select: { id: true, ownerID: true },
    });
    const page = rows.slice(0, RECIPIENT_PAGE_SIZE);
    await this.broadcast(
      page.map((row) => row.ownerID),
      payload,
    );
    await this.sendAssistantAlerts(
      page.map((row) => row.ownerID),
      alertStatus(job, payload),
      payload,
    );

    if (rows.length > RECIPIENT_PAGE_SIZE) {
      await this.persistProgress(job, leaseToken, {
        status: 'PENDING',
        stage: 'OWNERS',
        noteCursor: page[page.length - 1].id,
        nextAttemptAt: new Date(),
        attempts: 0,
        lastError: null,
        lockedAt: null,
        leaseToken: null,
      });
      return;
    }

    await this.persistProgress(job, leaseToken, {
      status: 'PENDING',
      stage: 'CHAT_MEMBERS',
      noteCursor: null,
      chatConversationCursor: null,
      chatUserCursor: null,
      nextAttemptAt: new Date(),
      attempts: 0,
      lastError: null,
      lockedAt: null,
      leaseToken: null,
    });
  }

  private async processChatMemberPage(
    job: FanoutJob,
    leaseToken: string,
    payload: SourcePayload,
  ): Promise<void> {
    const conversationCursor = job.chatConversationCursor ?? '';
    const userCursor = job.chatUserCursor ?? '';
    const rows = await this.prisma.$queryRaw<
      Array<{ conversationID: string; userID: string }>
    >`
      SELECT
        conversation."conversationID" AS "conversationID",
        member."userID" AS "userID"
      FROM (
        SELECT DISTINCT message."conversationID"
        FROM "ChatMessage" AS message
        WHERE message."sourceNoteID" = ${job.rootNoteID}
          AND message."type" = 'note-card'
          AND message."deleted" = false
          AND message."revokedAt" IS NULL
      ) AS conversation
      JOIN "ChatMember" AS member
        ON member."conversationID" = conversation."conversationID"
       AND member."leftAt" IS NULL
      WHERE (
          conversation."conversationID" > ${conversationCursor}
          OR (
            conversation."conversationID" = ${conversationCursor}
            AND member."userID" > ${userCursor}
          )
        )
      ORDER BY conversation."conversationID" ASC, member."userID" ASC
      LIMIT ${RECIPIENT_PAGE_SIZE + 1}`;
    const page = rows.slice(0, RECIPIENT_PAGE_SIZE);
    // 只是在聊天里见过名片、没收进自己笔记库的人:名片状态照刷,不发助手提醒。
    await this.broadcast(
      page.map((row) => row.userID),
      payload,
    );

    if (rows.length > RECIPIENT_PAGE_SIZE) {
      const last = page[page.length - 1];
      await this.persistProgress(job, leaseToken, {
        status: 'PENDING',
        stage: 'CHAT_MEMBERS',
        chatConversationCursor: last.conversationID,
        chatUserCursor: last.userID,
        nextAttemptAt: new Date(),
        attempts: 0,
        lastError: null,
        lockedAt: null,
        leaseToken: null,
      });
      return;
    }

    await this.prisma.noteStatusFanoutOutbox.deleteMany({
      where: this.claimedWhere(job, leaseToken),
    });
  }

  private async broadcast(
    recipientIDs: string[],
    payload: SourcePayload,
  ): Promise<void> {
    const uniqueRecipientIDs = [...new Set(recipientIDs)];
    const realtimePayload = {
      sourceNoteId: payload.sourceNoteId,
      workStatus: payload.workStatus,
      status: payload.status,
      available: payload.available,
    };
    await this.realtime.safeBroadcastAll(
      uniqueRecipientIDs.map(
        (userID) => () =>
          this.realtime.broadcastNoteSourceStatusChanged(
            userID,
            realtimePayload,
          ),
      ),
    );
  }

  private async sendAssistantAlerts(
    recipientIDs: string[],
    status: 'CLOSED' | 'WORKING' | null,
    payload: SourcePayload,
  ): Promise<void> {
    if (!this.assistant || !status) return;
    const candidates = [
      ...new Set(recipientIDs.filter((id) => id && id !== payload.ownerID)),
    ];
    if (candidates.length === 0) return;
    // 默认开启:没有设置行的人照发,只跳过明确关掉的。
    const optedOut = await this.prisma.assistantPreference.findMany({
      where: {
        userID: { in: candidates },
        assistantKey: ASSISTANT_KEY,
        noteStatusAlerts: false,
      },
      select: { userID: true },
    });
    const muted = new Set(optedOut.map((row) => row.userID));
    // 收藏的人多时一页就是 100 条提醒,逐条发,不让一页同时占满连接池;
    // 整页失败重试时,已发的那些按 clientMessageId 去重,不会重复。
    for (const userId of candidates) {
      if (muted.has(userId)) continue;
      await this.assistant.sendNoteStatusAlert(userId, {
        sourceNoteId: payload.sourceNoteId,
        title: payload.title,
        status,
        changedAt: payload.changedAt,
      });
    }
  }

  private claimedWhere(job: FanoutJob, leaseToken: string) {
    return {
      rootNoteID: job.rootNoteID,
      generation: job.generation,
      leaseToken,
      status: 'PROCESSING' as const,
    };
  }

  private async persistProgress(
    job: FanoutJob,
    leaseToken: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const updated = await this.prisma.noteStatusFanoutOutbox.updateMany({
      where: this.claimedWhere(job, leaseToken),
      data,
    });
    return updated.count > 0;
  }

  private nextRetryAt(attempts: number): Date {
    return new Date(
      Date.now() +
        Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1)),
    );
  }

  private errorCategory(error: unknown): string {
    return error instanceof Error ? error.name.slice(0, 1000) : 'UnknownError';
  }
}
