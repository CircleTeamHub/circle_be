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

const MIN_CREDIT_SCORE = 0;
const MAX_CREDIT_SCORE = 100;

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

    const user = await client.user.findUnique({
      where: { id: input.userId },
      select: { id: true, creditScore: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const scoreBefore = user.creditScore;
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
