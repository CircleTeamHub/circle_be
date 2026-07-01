import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import { CreditPolicyService } from './credit-policy.service';

type CreditClient = Prisma.TransactionClient | PrismaService;

export type CreditDeltaInput = {
  userId: string;
  delta: number;
  reason: string;
  sourceType: string;
  sourceId?: string | null;
  actorId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreditDeltaResult = {
  eventId: string;
  scoreBefore: number;
  scoreAfter: number;
};

export type CreditRevertInput = {
  reason?: string;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreditRevertResult = {
  reverted: boolean;
  userId?: string;
  reversalEventId?: string;
  scoreBefore?: number;
  scoreAfter?: number;
};

const MIN_CREDIT_SCORE = 0;
const MAX_CREDIT_SCORE = 100;

// Reversal (compensating) entries carry their own source type so that
// "find the original debit for this source" lookups never match a reversal,
// and point sourceID at the event they undo.
const CREDIT_REVERT_SOURCE_TYPE = 'CREDIT_REVERT';

function clampCreditScore(score: number) {
  return Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, score));
}

@Injectable()
export class CreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly creditPolicyService: CreditPolicyService,
  ) {}

  async applyDelta(input: CreditDeltaInput): Promise<CreditDeltaResult> {
    const result = await runSerializableTransaction(this.prisma, (tx) =>
      this.applyDeltaInTransaction(tx, input),
    );
    await this.broadcastCreditProfileChanged(input.userId);
    return result;
  }

  /**
   * Reverses a single credit event by posting an equal-and-opposite
   * compensating entry and stamping `revertedAt` on the original. The ledger
   * stays append-only — history is never mutated beyond the void marker.
   *
   * Idempotent: an already-reverted (or missing) event yields
   * `{ reverted: false }` and no new entry. Runs Serializable + retry so a
   * concurrent double-revert of the same event resolves to a single reversal.
   *
   * Note: the compensating delta is the original's nominal delta. Because
   * scores are clamped to [0, 100], a debit that was itself clamped may not be
   * restored 1:1 — acceptable for a bounded reputation score.
   */
  async revertEvent(
    eventId: string,
    options: CreditRevertInput = {},
  ): Promise<CreditRevertResult> {
    const result = await runSerializableTransaction(this.prisma, (tx) =>
      this.revertEventInTransaction(tx, eventId, options),
    );
    if (result.reverted && result.userId) {
      await this.broadcastCreditProfileChanged(result.userId);
    }
    return result;
  }

  /**
   * Reverses the most recent un-reverted debit/credit recorded for a given
   * source (e.g. `('FRIEND_REPORT', reportId)` to refund a withdrawn report).
   * Never matches a reversal entry, which carries its own source type.
   */
  async revertBySource(
    sourceType: string,
    sourceId: string,
    options: CreditRevertInput = {},
  ): Promise<CreditRevertResult> {
    const result = await runSerializableTransaction(this.prisma, async (tx) => {
      const original = await tx.creditEvent.findFirst({
        where: { sourceType, sourceID: sourceId, revertedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!original) {
        return { reverted: false as const };
      }
      return this.revertEventInTransaction(tx, original.id, options);
    });
    if (result.reverted && result.userId) {
      await this.broadcastCreditProfileChanged(result.userId);
    }
    return result;
  }

  private async revertEventInTransaction(
    client: CreditClient,
    eventId: string,
    options: CreditRevertInput,
  ): Promise<CreditRevertResult> {
    const event = await client.creditEvent.findUnique({
      where: { id: eventId },
      select: { id: true, userID: true, delta: true, revertedAt: true },
    });
    if (!event || event.revertedAt) {
      return { reverted: false };
    }

    const reversal = await this.applyDeltaInTransaction(client, {
      userId: event.userID,
      delta: -event.delta,
      reason: options.reason ?? 'REVERT',
      sourceType: CREDIT_REVERT_SOURCE_TYPE,
      sourceId: event.id,
      actorId: options.actorId ?? null,
      idempotencyKey: `revert:${event.id}`,
      metadata: {
        revertOf: event.id,
        revertReason: options.reason ?? null,
        ...(options.metadata ?? {}),
      },
    });

    await client.creditEvent.update({
      where: { id: event.id },
      data: { revertedAt: new Date() },
    });

    return {
      reverted: true,
      userId: event.userID,
      reversalEventId: reversal.eventId,
      scoreBefore: reversal.scoreBefore,
      scoreAfter: reversal.scoreAfter,
    };
  }

  async applyDeltaInTransaction(
    client: CreditClient,
    input: CreditDeltaInput,
  ): Promise<CreditDeltaResult> {
    if (input.idempotencyKey) {
      const existing = await client.creditEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, scoreBefore: true, scoreAfter: true },
      });
      if (existing) {
        return {
          eventId: existing.id,
          scoreBefore: existing.scoreBefore,
          scoreAfter: existing.scoreAfter,
        };
      }
    }

    // Lock the user row for the remainder of the transaction so concurrent
    // credit deltas on the same user serialize. Without this, two Read
    // Committed transactions (e.g. two friend reports against the same target)
    // can both read the same scoreBefore and lose an update — corrupting both
    // the balance and the ledger's scoreBefore/scoreAfter. Requires an
    // enclosing transaction, which every caller provides.
    const lockedRows = await client.$queryRaw<Array<{ creditScore: number }>>(
      Prisma.sql`SELECT "creditScore" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`,
    );
    const locked = lockedRows[0];
    if (!locked) {
      throw new NotFoundException('User not found');
    }

    const scoreBefore = locked.creditScore;
    const scoreAfter = clampCreditScore(scoreBefore + input.delta);
    await client.user.update({
      where: { id: input.userId },
      data: { creditScore: scoreAfter },
      select: { id: true, creditScore: true },
    });
    const event = await client.creditEvent.create({
      data: {
        userID: input.userId,
        delta: input.delta,
        scoreBefore,
        scoreAfter,
        reason: input.reason,
        sourceType: input.sourceType,
        sourceID: input.sourceId ?? null,
        actorID: input.actorId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true, scoreBefore: true, scoreAfter: true },
    });
    this.creditPolicyService.invalidateUserPolicyCache(input.userId);

    return {
      eventId: event.id,
      scoreBefore: event.scoreBefore,
      scoreAfter: event.scoreAfter,
    };
  }

  async broadcastCreditProfileChanged(userId: string) {
    await this.realtimeService.safeBroadcastAll([
      () => this.realtimeService.invalidateUserProfileSummaryCache(userId),
      () => this.realtimeService.broadcastUserProfileSummary(userId),
    ]);
  }
}
