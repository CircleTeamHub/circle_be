import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from 'src/generated/prisma';
import { NoteRatingErrorCode } from 'src/common/app-error-codes';
import { CreditService } from 'src/credit/credit.service';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { createLoggingConfig } from 'src/logging/logging.config';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  ListNoteRatingCasesQueryDto,
  NoteRatingCaseDto,
  NoteRatingCaseListDto,
  ResolveNoteRatingCaseDto,
} from './dto/note-rating-admin.dto';
import { NOTE_RATING_ABUSE_CREDIT_DEDUCTION } from './note-rating.constants';
import { lockOwner, transitionRatings } from './note-rating-ledger';

const ACTIONS_BY_KIND = {
  BURST: ['RELEASE', 'VOID'],
  APPEAL: ['UPHOLD', 'REVOKE'],
} as const;

const USER_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
} as const;

const CASE_INCLUDE = {
  owner: { select: USER_SELECT },
  resolvedBy: { select: USER_SELECT },
  items: {
    select: {
      rating: {
        select: {
          id: true,
          noteID: true,
          value: true,
          reason: true,
          comment: true,
          status: true,
          createdAt: true,
          rater: {
            select: { ...USER_SELECT, creditScore: true, createdAt: true },
          },
        },
      },
    },
  },
} as const;

type CaseRow = Prisma.NoteRatingCaseGetPayload<{
  include: typeof CASE_INCLUDE;
}>;

const NOTE_TITLE_PREVIEW = 30;
const NOTIFY_RATER_PENALIZED = `你的一次笔记评分经核实属于集中刷分或恶意差评，已被作废，信誉分下降 ${NOTE_RATING_ABUSE_CREDIT_DEDUCTION} 分。`;

function appealOutcomeText(title: string | null, revoked: boolean): string {
  const name = title
    ? `「${Array.from(title).slice(0, NOTE_TITLE_PREVIEW).join('')}」`
    : '';
  return revoked
    ? `你对笔记${name}一条差评的申诉已通过，该差评已撤销。`
    : `你对笔记${name}一条差评的申诉经核实未通过，差评保留。`;
}

@Injectable()
export class NoteRatingAdminService {
  private readonly logger = new Logger(NoteRatingAdminService.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
    private readonly notificationService: NotificationService,
    private readonly realtimeService: RealtimeService,
  ) {}

  async listCases(
    query: ListNoteRatingCasesQueryDto,
  ): Promise<NoteRatingCaseListDto> {
    const status = query.status ?? 'PENDING';
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = { status, ...(query.kind ? { kind: query.kind } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.noteRatingCase.findMany({
        where,
        // The pending queue is worked oldest first; history newest first.
        orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: CASE_INCLUDE,
      }),
      this.prisma.noteRatingCase.count({ where }),
    ]);
    const items = await this.toDtos(rows);
    return {
      items,
      total,
      page,
      limit,
      hasMore: (page - 1) * limit + rows.length < total,
    };
  }

  async resolveCase(
    adminID: string,
    caseID: string,
    dto: ResolveNoteRatingCaseDto,
  ): Promise<NoteRatingCaseDto> {
    const found = await this.prisma.noteRatingCase.findUnique({
      where: { id: caseID },
      select: { kind: true, ownerID: true },
    });
    if (!found) throw new NotFoundException('Rating case not found');
    if (
      !(ACTIONS_BY_KIND[found.kind] as readonly string[]).includes(dto.action)
    ) {
      throw new BadRequestException({
        message: `${dto.action} does not apply to a ${found.kind} case`,
        errorCode: NoteRatingErrorCode.CaseActionInvalid,
      });
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Same owner lock as new ratings: the counters of this owner's notes
      // move here, and burst detection reads these statuses.
      await lockOwner(tx, found.ownerID);
      // The conditional update doubles as the "first admin wins" guard.
      const claimed = await tx.noteRatingCase.updateMany({
        where: { id: caseID, status: 'PENDING' },
        data: {
          status: 'RESOLVED',
          resolution: dto.action,
          resolutionNote: dto.note || null,
          resolvedByID: adminID,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          message: 'Rating case already resolved',
          errorCode: NoteRatingErrorCode.CaseResolved,
        });
      }
      const ratings = await tx.noteRating.findMany({
        where: { caseItems: { some: { caseID } } },
        select: {
          id: true,
          noteID: true,
          value: true,
          status: true,
          ratedDay: true,
          raterID: true,
        },
      });

      let voided: typeof ratings = [];
      if (dto.action === 'RELEASE') {
        await transitionRatings(
          tx,
          ratings.filter((rating) => rating.status === 'HELD'),
          'COUNTED',
        );
      } else if (dto.action === 'VOID' || dto.action === 'REVOKE') {
        const changed = new Set(
          (await transitionRatings(tx, ratings, 'VOID')).map(
            (rating) => rating.id,
          ),
        );
        // Lock the raters' User rows in one global order: two admins resolving
        // cases of different owners that share raters must not deadlock.
        voided = ratings
          .filter((rating) => changed.has(rating.id))
          .sort((a, b) => a.raterID.localeCompare(b.raterID));
        for (const rating of voided) {
          await this.creditService.applyDeltaInTransaction(tx, {
            userId: rating.raterID,
            delta: -NOTE_RATING_ABUSE_CREDIT_DEDUCTION,
            reason: 'NOTE_RATING_ABUSE',
            sourceType: 'NOTE_RATING',
            sourceId: rating.id,
            actorId: adminID,
            idempotencyKey: `note-rating-void:${rating.id}`,
            metadata: { caseId: caseID, kind: found.kind },
          });
        }
      }
      return { ratings, voided };
    });

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'note_rating_case_resolved',
      actorId: adminID,
      targetId: found.ownerID,
      entityType: 'note_rating_case',
      entityId: caseID,
      result: 'success',
      metadata: {
        kind: found.kind,
        action: dto.action,
        ratings: outcome.ratings.length,
        penalized: outcome.voided.length,
      },
    });

    await this.notifyOutcome(found.kind, dto.action, found.ownerID, outcome);
    const [resolved] = await this.toDtos([
      await this.prisma.noteRatingCase.findUniqueOrThrow({
        where: { id: caseID },
        include: CASE_INCLUDE,
      }),
    ]);
    return resolved;
  }

  /**
   * Post-commit and best effort: a failed notification or credit broadcast
   * must never undo or fail a decision that is already committed.
   */
  private async notifyOutcome(
    kind: 'BURST' | 'APPEAL',
    action: ResolveNoteRatingCaseDto['action'],
    ownerID: string,
    outcome: {
      ratings: Array<{ noteID: string }>;
      voided: Array<{ raterID: string }>;
    },
  ): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    const penalized = [
      ...new Set(outcome.voided.map((rating) => rating.raterID)),
    ];
    for (const raterID of penalized) {
      tasks.push(this.creditService.broadcastCreditProfileChanged(raterID));
      tasks.push(this.notifySystem(raterID, NOTIFY_RATER_PENALIZED));
    }
    if (kind === 'APPEAL') {
      const noteID = outcome.ratings[0]?.noteID;
      const note = noteID
        ? await this.prisma.note.findUnique({
            where: { id: noteID },
            select: { title: true },
          })
        : null;
      tasks.push(
        this.notifySystem(
          ownerID,
          appealOutcomeText(note?.title ?? null, action === 'REVOKE'),
        ),
      );
    }
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `note rating case follow-up failed: ${String(result.reason)}`,
        );
      }
    }
  }

  /** Same delivery as the friend-report outcome notifications. */
  private async notifySystem(userID: string, content: string): Promise<void> {
    const notification =
      await this.notificationService.createSystemNotification(
        userID,
        userID,
        content,
      );
    await this.realtimeService.safeBroadcastAll([
      () =>
        this.realtimeService.broadcastSystemNotificationCreated(
          userID,
          content,
        ),
      ...(notification
        ? [
            () =>
              this.realtimeService.broadcastNotificationCreated(
                userID,
                notification,
              ),
          ]
        : []),
      () => this.realtimeService.broadcastSystemNotificationUnread(userID),
    ]);
  }

  private async toDtos(rows: CaseRow[]): Promise<NoteRatingCaseDto[]> {
    const noteIDs = [
      ...new Set(
        rows.flatMap((row) => row.items.map((item) => item.rating.noteID)),
      ),
    ];
    // Ratings outlive a purged note, so a missing row is shown as such.
    const notes = new Map(
      (noteIDs.length
        ? await this.prisma.note.findMany({
            where: { id: { in: noteIDs } },
            select: { id: true, title: true, status: true },
          })
        : []
      ).map((note) => [note.id, note]),
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      owner: row.owner,
      ownerReason: row.ownerReason,
      resolution: row.resolution,
      resolutionNote: row.resolutionNote,
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      ratings: row.items
        .map(({ rating }) => ({
          id: rating.id,
          note: {
            id: rating.noteID,
            title: notes.get(rating.noteID)?.title ?? null,
            status: notes.get(rating.noteID)?.status ?? null,
          },
          rater: {
            id: rating.rater.id,
            accountId: rating.rater.accountId,
            nickname: rating.rater.nickname,
            avatarUrl: rating.rater.avatarUrl,
            creditScore: rating.rater.creditScore,
            registeredAt: rating.rater.createdAt,
          },
          value: rating.value,
          reason: rating.reason,
          comment: rating.comment,
          status: rating.status,
          createdAt: rating.createdAt,
        }))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    }));
  }
}
