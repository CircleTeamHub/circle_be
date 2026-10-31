import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CreditEventDto } from './dto/credit-event.dto';

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
// 信誉值页「近期记录」只展示最近这些条，与积分流水同一口径。
const RECENT_EVENTS_LIMIT = 50;

function clampCreditScore(score: number) {
  return Math.max(MIN_CREDIT_SCORE, Math.min(MAX_CREDIT_SCORE, score));
}

// metadata 是各写入方自带的 JSON；对用户只透出举报分类，其余字段留在服务端。
function readCategory(metadata: Prisma.JsonValue): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const category = metadata.category;
  return typeof category === 'string' ? category : null;
}

@Injectable()
export class CreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
  ) {}

  async getRecentEvents(userId: string): Promise<CreditEventDto[]> {
    const events = await this.prisma.creditEvent.findMany({
      where: { userID: userId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_EVENTS_LIMIT,
      // 只取用户自己该看的列：actorID 是审核的管理员，sourceID / idempotencyKey
      // 指向举报单，都不属于用户契约，被举报人拿到它们就能去猜举报人。
      select: {
        id: true,
        delta: true,
        scoreAfter: true,
        reason: true,
        metadata: true,
        createdAt: true,
      },
    });
    return events.map(({ metadata, ...event }) => ({
      ...event,
      category: readCategory(metadata),
    }));
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
    // Post-commit hook: every score-change path (friend-report approval) calls
    // this after its transaction commits. Invalidate the cached profile
    // summary first (synchronous, immediate) then broadcast the change.
    await this.realtimeService.safeBroadcastAll([
      // 失效方法现返回 boolean（供会员发放路径复检）；credit 这里不关心结果，包一层丢弃成 void。
      async () => {
        await this.realtimeService.invalidateUserProfileSummaryCache(userId);
      },
      () => this.realtimeService.broadcastUserProfileSummary(userId),
    ]);
  }
}
