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

    return {
      eventId: event.id,
      scoreBefore: event.scoreBefore,
      scoreAfter: event.scoreAfter,
    };
  }

  async broadcastCreditProfileChanged(userId: string) {
    // 提交后钩子：所有改分路径（applyDelta / revert* / friend-report）在事务提交后
    // 都会走到这里。信誉发言闸门缓存的失效放在这里、而非事务内——事务内失效存在竞态
    // （回滚也会失效；并发 callback 可能读到未提交旧值再缓存，直到 TTL 才纠正）。
    // 先做同步 Map 失效（必成功、即刻生效），再异步广播资料变更。
    this.creditPolicyService.invalidateUserPolicyCache(userId);
    await this.realtimeService.safeBroadcastAll([
      () => this.realtimeService.invalidateUserProfileSummaryCache(userId),
      () => this.realtimeService.broadcastUserProfileSummary(userId),
    ]);
  }
}
