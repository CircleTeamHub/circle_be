import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from 'src/generated/prisma';
import { NoteErrorCode, NoteRatingErrorCode } from 'src/common/app-error-codes';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { createLoggingConfig } from 'src/logging/logging.config';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AppealNoteRatingDto,
  CreateNoteRatingDto,
  ListNoteBadRatingsQueryDto,
  NoteBadRatingDto,
  NoteBadRatingListDto,
  NoteRatingAppealDto,
  NoteRatingResultDto,
  NoteRatingSummaryDto,
} from './dto/note-rating.dto';
import {
  NOTE_RATING_APPEALS_PER_MONTH,
  NOTE_RATING_BURST_THRESHOLD,
  NOTE_RATING_BURST_WINDOW_MS,
  NOTE_RATING_MIN_ACCOUNT_AGE_MS,
  NOTE_RATING_MIN_CREDIT,
  NOTE_RATING_NOTE_COOLDOWN_MS,
  NOTE_RATING_NOTE_DAILY_CAP,
} from './note-rating.constants';
import { ratingCalendar, type RatingCalendar } from './note-rating-calendar';
import {
  loadMonthlyCounters,
  ZERO_RATING_COUNTERS,
} from './note-rating-counters';
import {
  adjustMonthly,
  claimDailySlot,
  lockOwner,
  lockRater,
  transitionRatings,
  type LedgerRating,
} from './note-rating-ledger';

type Client = PrismaService | Prisma.TransactionClient;

type NoteRatingBlockCode =
  (typeof NoteRatingErrorCode)[keyof typeof NoteRatingErrorCode];

/** A group card on the source note, as stored in `sections.groups.items`. */
type GroupCardRef = { id: string; circleId?: string; conversationID?: string };

type RatingTarget = {
  /** Root of the collect chain: ratings and counters always live here. */
  noteID: string;
  ownerID: string;
  groupCards: GroupCardRef[];
};

type Block = { reason: NoteRatingBlockCode | null; nextRatableAt: Date | null };

const LEDGER_SELECT = {
  id: true,
  noteID: true,
  value: true,
  status: true,
  ratedDay: true,
} as const;

const APPEAL_ITEMS = {
  where: { case: { kind: 'APPEAL' } },
  select: {
    case: {
      select: {
        status: true,
        resolution: true,
        ownerReason: true,
        createdAt: true,
        resolvedAt: true,
      },
    },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Group cards of the source note. Same field rules as NoteService.toCardPeers. */
export function groupCardsOf(sections: unknown): GroupCardRef[] {
  const groups = isRecord(sections) ? sections.groups : null;
  const items = isRecord(groups) ? groups.items : null;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const id = isRecord(item) ? nonEmptyString(item.id) : undefined;
    if (!isRecord(item) || !id) return [];
    return [
      {
        id,
        circleId: nonEmptyString(item.circleId),
        conversationID: nonEmptyString(item.conversationID),
      },
    ];
  });
}

function rejected(reason: NoteRatingBlockCode, nextRatableAt: Date | null) {
  const body = {
    message: `Note rating rejected: ${reason}`,
    errorCode: reason,
    ...(nextRatableAt ? { details: { nextRatableAt } } : {}),
  };
  const limit =
    reason === NoteRatingErrorCode.RaterDailyLimit ||
    reason === NoteRatingErrorCode.Cooldown ||
    reason === NoteRatingErrorCode.NoteGoodFull ||
    reason === NoteRatingErrorCode.NoteBadFull;
  return limit ? new ConflictException(body) : new ForbiddenException(body);
}

@Injectable()
export class NoteRatingService {
  private readonly logger = new Logger(NoteRatingService.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(private readonly prisma: PrismaService) {}

  async getSummary(
    viewerID: string,
    noteId: string,
  ): Promise<NoteRatingSummaryDto> {
    const target = await this.resolveTarget(viewerID, noteId);
    const now = new Date();
    const calendar = ratingCalendar(now);
    const counters =
      (await loadMonthlyCounters(this.prisma, [target.noteID], now)).get(
        target.noteID,
      ) ?? ZERO_RATING_COUNTERS;
    const block = await this.findBlock(
      this.prisma,
      viewerID,
      target,
      now,
      calendar,
    );
    const today = await this.prisma.noteRatingDaily.findUnique({
      where: { noteID_day: { noteID: target.noteID, day: calendar.day } },
      select: { goodCount: true, badCount: true },
    });
    return {
      noteId: target.noteID,
      month: calendar.month,
      ...counters,
      canRate: block.reason === null,
      reason: block.reason,
      nextRatableAt: block.nextRatableAt,
      goodFull: (today?.goodCount ?? 0) >= NOTE_RATING_NOTE_DAILY_CAP,
      badFull: (today?.badCount ?? 0) >= NOTE_RATING_NOTE_DAILY_CAP,
    };
  }

  async rate(
    raterID: string,
    noteId: string,
    dto: CreateNoteRatingDto,
  ): Promise<NoteRatingResultDto> {
    const value = dto.value;
    const reason = value === 'BAD' ? (dto.reason ?? null) : null;
    const comment = dto.comment || null;
    if (value === 'GOOD' && (dto.reason || comment)) {
      throw new BadRequestException('A good rating carries no reason or text');
    }
    if (value === 'BAD' && !reason) {
      throw new BadRequestException('A bad rating needs a reason');
    }
    if (reason === 'OTHER' && !comment) {
      throw new BadRequestException('The OTHER reason needs a description');
    }

    const target = await this.resolveTarget(raterID, noteId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Rater lock: the per-rater daily and per-note cooldown checks below.
      // Owner lock: burst detection and the counters, which raters of the same
      // owner would otherwise race (each would miss the others' fresh rows).
      await lockRater(tx, raterID);
      await lockOwner(tx, target.ownerID);
      // Read the clock after the locks so createdAt follows commit order.
      const now = new Date();
      const calendar = ratingCalendar(now);

      const block = await this.findBlock(tx, raterID, target, now, calendar);
      if (block.reason) throw rejected(block.reason, block.nextRatableAt);

      // Every rating on this note is also a rating for its owner, so the
      // owner-wide window covers the doc's "same note or same owner" rule.
      const peers = await tx.noteRating.findMany({
        where: {
          ownerID: target.ownerID,
          value,
          status: { in: ['COUNTED', 'HELD'] },
          createdAt: {
            gt: new Date(now.getTime() - NOTE_RATING_BURST_WINDOW_MS),
          },
        },
        select: LEDGER_SELECT,
      });
      const burst = peers.length + 1 >= NOTE_RATING_BURST_THRESHOLD;
      // Held ratings do not take the note's daily slots, so a burst never hits
      // the cap check and cannot lock real raters out for the day.
      if (
        !burst &&
        !(await claimDailySlot(tx, target.noteID, calendar.dayKey, value))
      ) {
        throw rejected(
          value === 'GOOD'
            ? NoteRatingErrorCode.NoteGoodFull
            : NoteRatingErrorCode.NoteBadFull,
          null,
        );
      }

      const rating = await tx.noteRating.create({
        data: {
          noteID: target.noteID,
          ownerID: target.ownerID,
          raterID,
          value,
          reason,
          comment: value === 'BAD' ? comment : null,
          status: burst ? 'HELD' : 'COUNTED',
          ratedDay: calendar.day,
          createdAt: now,
        },
        select: LEDGER_SELECT,
      });

      let caseID: string | null = null;
      if (burst) {
        caseID = await this.holdBurst(tx, target.ownerID, peers, rating);
      } else {
        await adjustMonthly(tx, target.noteID, calendar.month, value, 1);
      }
      const counters =
        (await loadMonthlyCounters(tx, [target.noteID], now)).get(
          target.noteID,
        ) ?? ZERO_RATING_COUNTERS;
      return {
        rating,
        caseID,
        heldCount: burst ? peers.length + 1 : 0,
        counters,
        now,
        month: calendar.month,
      };
    });

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'note_rating_created',
      actorId: raterID,
      targetId: target.ownerID,
      entityType: 'note',
      entityId: target.noteID,
      result: 'success',
      metadata: { value, reason, status: outcome.rating.status },
    });
    if (outcome.caseID) {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'note_rating_burst_held',
        targetId: target.ownerID,
        entityType: 'note_rating_case',
        entityId: outcome.caseID,
        result: 'success',
        metadata: { value, heldCount: outcome.heldCount },
      });
    }

    return {
      noteId: target.noteID,
      month: outcome.month,
      ...outcome.counters,
      ratingId: outcome.rating.id,
      status: outcome.rating.status === 'HELD' ? 'HELD' : 'COUNTED',
      // The per-note cooldown (72h) always outlasts the per-rater daily limit.
      nextRatableAt: new Date(
        outcome.now.getTime() + NOTE_RATING_NOTE_COOLDOWN_MS,
      ),
    };
  }

  async listBadRatings(
    ownerID: string,
    noteId: string,
    query: ListNoteBadRatingsQueryDto,
  ): Promise<NoteBadRatingListDto> {
    const target = await this.resolveTarget(ownerID, noteId);
    if (target.ownerID !== ownerID) {
      throw new ForbiddenException('Only the note owner can see bad ratings');
    }
    const limit = query.limit ?? 20;
    const cursor = query.cursor
      ? await this.prisma.noteRating.findFirst({
          where: { id: query.cursor, noteID: target.noteID },
          select: { id: true, createdAt: true },
        })
      : null;
    const rows = await this.prisma.noteRating.findMany({
      where: {
        noteID: target.noteID,
        value: 'BAD',
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      // The rater stays out of the owner's view: no raterID here.
      select: {
        id: true,
        reason: true,
        comment: true,
        status: true,
        createdAt: true,
        caseItems: APPEAL_ITEMS,
      },
    });
    const appealsRemaining = await this.appealsRemaining(
      this.prisma,
      ownerID,
      ratingCalendar(new Date()),
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => this.toBadRatingDto(row, appealsRemaining)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      appealsRemaining,
    };
  }

  async appeal(
    ownerID: string,
    ratingId: string,
    dto: AppealNoteRatingDto,
  ): Promise<NoteBadRatingDto> {
    const calendar = ratingCalendar(new Date());
    const { caseID, noteID } = await this.prisma.$transaction(async (tx) => {
      // Serializes the monthly quota count and the once-per-rating check.
      await lockOwner(tx, ownerID);
      const rating = await tx.noteRating.findFirst({
        where: { id: ratingId, ownerID, value: 'BAD' },
        select: {
          id: true,
          noteID: true,
          status: true,
          caseItems: APPEAL_ITEMS,
        },
      });
      if (!rating) {
        throw new NotFoundException({
          message: 'Rating not found',
          errorCode: NoteRatingErrorCode.NotFound,
        });
      }
      if (rating.caseItems.length > 0) {
        throw new ConflictException({
          message: 'This rating was already appealed',
          errorCode: NoteRatingErrorCode.AlreadyAppealed,
        });
      }
      if (rating.status !== 'COUNTED') {
        throw new ConflictException({
          message: 'Only a counted bad rating can be appealed',
          errorCode: NoteRatingErrorCode.NotAppealable,
        });
      }
      if ((await this.appealsRemaining(tx, ownerID, calendar)) <= 0) {
        throw new ConflictException({
          message: 'Monthly appeal quota reached',
          errorCode: NoteRatingErrorCode.AppealQuota,
        });
      }
      // The rating stays COUNTED while the appeal is pending, so appealing
      // everything cannot hide bad ratings.
      const created = await tx.noteRatingCase.create({
        data: {
          kind: 'APPEAL',
          ownerID,
          ownerReason: dto.reason,
          items: { create: { ratingID: rating.id } },
        },
        select: { id: true },
      });
      return { caseID: created.id, noteID: rating.noteID };
    });

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'note_rating_appeal_created',
      actorId: ownerID,
      entityType: 'note_rating_case',
      entityId: caseID,
      result: 'success',
      metadata: { noteId: noteID },
    });

    const row = await this.prisma.noteRating.findUniqueOrThrow({
      where: { id: ratingId },
      select: {
        id: true,
        reason: true,
        comment: true,
        status: true,
        createdAt: true,
        caseItems: APPEAL_ITEMS,
      },
    });
    return this.toBadRatingDto(
      row,
      await this.appealsRemaining(this.prisma, ownerID, calendar),
    );
  }

  /**
   * The note the viewer opened may be their collected copy or any copy in the
   * chain; ratings always go to the root. A root in the recycle bin or purged
   * cannot be rated.
   */
  private async resolveTarget(
    viewerID: string,
    noteId: string,
  ): Promise<RatingTarget> {
    const opened = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        status: { not: 'DELETED' },
        OR: [{ ownerID: viewerID }, { available: true, status: 'ACTIVE' }],
      },
      select: { id: true, rootSourceNoteID: true },
    });
    const root = opened
      ? await this.prisma.note.findFirst({
          where: {
            id: opened.rootSourceNoteID ?? opened.id,
            status: { not: 'DELETED' },
          },
          select: { id: true, ownerID: true, sections: true },
        })
      : null;
    if (!root) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    return {
      noteID: root.id,
      ownerID: root.ownerID,
      groupCards: groupCardsOf(root.sections),
    };
  }

  /** First rule the viewer fails, in the order the app explains them. */
  private async findBlock(
    client: Client,
    raterID: string,
    target: RatingTarget,
    now: Date,
    calendar: RatingCalendar,
  ): Promise<Block> {
    const blocked = (reason: NoteRatingBlockCode): Block => ({
      reason,
      nextRatableAt: null,
    });
    if (target.ownerID === raterID) return blocked(NoteRatingErrorCode.Owner);
    if (target.groupCards.length === 0) {
      return blocked(NoteRatingErrorCode.NoGroup);
    }
    const copy = await client.note.findFirst({
      where: {
        ownerID: raterID,
        rootSourceNoteID: target.noteID,
        status: { not: 'DELETED' },
      },
      select: { id: true },
    });
    if (!copy) return blocked(NoteRatingErrorCode.NotCollected);
    if (!(await this.isMemberOfAnyGroup(client, raterID, target.groupCards))) {
      return blocked(NoteRatingErrorCode.NotInGroup);
    }
    const rater = await client.user.findUnique({
      where: { id: raterID },
      select: { creditScore: true, createdAt: true },
    });
    if (!rater || rater.creditScore < NOTE_RATING_MIN_CREDIT) {
      return blocked(NoteRatingErrorCode.LowCredit);
    }
    if (
      now.getTime() - rater.createdAt.getTime() <
      NOTE_RATING_MIN_ACCOUNT_AGE_MS
    ) {
      return blocked(NoteRatingErrorCode.AccountTooNew);
    }

    // Any status counts here: held and voided ratings used the rater's quota.
    const ratedToday = await client.noteRating.findFirst({
      where: { raterID, createdAt: { gte: calendar.dayStart } },
      select: { id: true },
    });
    const lastOnNote = await client.noteRating.findFirst({
      where: {
        raterID,
        noteID: target.noteID,
        createdAt: {
          gt: new Date(now.getTime() - NOTE_RATING_NOTE_COOLDOWN_MS),
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!ratedToday && !lastOnNote)
      return { reason: null, nextRatableAt: null };
    const cooldownEnds = lastOnNote
      ? lastOnNote.createdAt.getTime() + NOTE_RATING_NOTE_COOLDOWN_MS
      : 0;
    const dayEnds = ratedToday ? calendar.nextDayStart.getTime() : 0;
    return {
      reason: ratedToday
        ? NoteRatingErrorCode.RaterDailyLimit
        : NoteRatingErrorCode.Cooldown,
      nextRatableAt: new Date(Math.max(cooldownEnds, dayEnds)),
    };
  }

  /**
   * Circle cards: an ACTIVE member (or the owner) of a circle that is not
   * deleted. Legacy circle cards carry the OpenIM group id (Circle.groupID)
   * plus `circleId`. Standalone group cards: a current seat in that GROUP
   * conversation. Same rules NoteService.canonicalizeNoteCards uses when the
   * owner attaches a card.
   */
  private async isMemberOfAnyGroup(
    client: Client,
    userID: string,
    cards: readonly GroupCardRef[],
  ): Promise<boolean> {
    const circleKeys = cards
      .filter((card) => !card.conversationID)
      .flatMap((card) =>
        card.circleId ? [card.id, card.circleId] : [card.id],
      );
    if (circleKeys.length > 0) {
      const circle = await client.circle.findFirst({
        where: {
          deleted: false,
          AND: [
            {
              OR: [{ id: { in: circleKeys } }, { groupID: { in: circleKeys } }],
            },
            {
              OR: [
                { ownerID: userID },
                { members: { some: { userID, status: 'ACTIVE' } } },
              ],
            },
          ],
        },
        select: { id: true },
      });
      if (circle) return true;
    }
    const seat = await client.chatMember.findFirst({
      where: {
        userID,
        leftAt: null,
        conversationID: {
          in: cards.map((card) => card.conversationID ?? card.id),
        },
        conversation: { type: 'GROUP', circleID: null },
      },
      select: { id: true },
    });
    return seat !== null;
  }

  /**
   * Holds the whole burst: earlier counted peers leave the counters (and free
   * their daily slots), the new rating is already HELD. Peers already held by
   * an open BURST case join that case instead of opening a second one.
   */
  private async holdBurst(
    tx: Prisma.TransactionClient,
    ownerID: string,
    peers: LedgerRating[],
    rating: LedgerRating,
  ): Promise<string> {
    await transitionRatings(tx, peers, 'HELD');
    const open = await tx.noteRatingCase.findFirst({
      where: {
        kind: 'BURST',
        status: 'PENDING',
        ownerID,
        items: { some: { ratingID: { in: peers.map((peer) => peer.id) } } },
      },
      select: { id: true },
    });
    const caseID =
      open?.id ??
      (
        await tx.noteRatingCase.create({
          data: { kind: 'BURST', ownerID },
          select: { id: true },
        })
      ).id;
    await tx.noteRatingCaseItem.createMany({
      data: [...peers, rating].map((item) => ({ caseID, ratingID: item.id })),
      skipDuplicates: true,
    });
    return caseID;
  }

  private async appealsRemaining(
    client: Client,
    ownerID: string,
    calendar: RatingCalendar,
  ): Promise<number> {
    const used = await client.noteRatingCase.count({
      where: {
        ownerID,
        kind: 'APPEAL',
        createdAt: { gte: calendar.monthStart },
      },
    });
    return Math.max(NOTE_RATING_APPEALS_PER_MONTH - used, 0);
  }

  private toBadRatingDto(
    row: {
      id: string;
      reason: NoteBadRatingDto['reason'] | null;
      comment: string | null;
      status: NoteBadRatingDto['status'];
      createdAt: Date;
      caseItems: Array<{
        case: {
          status: 'PENDING' | 'RESOLVED';
          resolution: string | null;
          ownerReason: string | null;
          createdAt: Date;
          resolvedAt: Date | null;
        };
      }>;
    },
    appealsRemaining: number,
  ): NoteBadRatingDto {
    const appealCase = row.caseItems[0]?.case ?? null;
    let appealStatus: NoteRatingAppealDto['status'] = 'PENDING';
    if (appealCase?.status === 'RESOLVED') {
      appealStatus = appealCase.resolution === 'REVOKE' ? 'REVOKED' : 'UPHELD';
    }
    return {
      id: row.id,
      // BAD ratings always carry a reason; the column is nullable for GOOD.
      reason: row.reason ?? 'OTHER',
      comment: row.comment,
      status: row.status,
      createdAt: row.createdAt,
      appeal: appealCase
        ? {
            status: appealStatus,
            reason: appealCase.ownerReason ?? '',
            createdAt: appealCase.createdAt,
            resolvedAt: appealCase.resolvedAt,
          }
        : null,
      canAppeal:
        !appealCase && row.status === 'COUNTED' && appealsRemaining > 0,
    };
  }
}
