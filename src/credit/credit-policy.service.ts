import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

export enum CreditPolicyAction {
  SEND_MESSAGE = 'SEND_MESSAGE',
}

export type CreditPolicyDecision = {
  allowed: boolean;
  code: 'LOW_CREDIT_SCORE' | null;
  currentScore: number;
  minScore: number;
  message: string | null;
};

export type CreditPolicyCheckInput = {
  action: CreditPolicyAction;
};

const CREDIT_POLICY_MIN_SCORE: Record<CreditPolicyAction, number> = {
  [CreditPolicyAction.SEND_MESSAGE]: 60,
};

const CREDIT_POLICY_BLOCK_MESSAGE: Record<CreditPolicyAction, string> = {
  [CreditPolicyAction.SEND_MESSAGE]: '信誉值低于 60，暂时无法发送消息',
};

const OPENIM_SEND_POLICY_CACHE_TTL_MS = 15_000;
const HYPHENLESS_UUID_RE =
  /^[0-9a-fA-F]{8}[0-9a-fA-F]{4}[0-9a-fA-F]{4}[0-9a-fA-F]{4}[0-9a-fA-F]{12}$/;

type OpenimSendPolicyCacheEntry = {
  userId: string;
  decision: CreditPolicyDecision;
  expiresAt: number;
};

function buildCreditPolicyDecision(
  action: CreditPolicyAction,
  currentScore: number,
): CreditPolicyDecision {
  const minScore = CREDIT_POLICY_MIN_SCORE[action];
  const allowed = currentScore >= minScore;
  return {
    allowed,
    code: allowed ? null : 'LOW_CREDIT_SCORE',
    currentScore,
    minScore,
    message: allowed ? null : CREDIT_POLICY_BLOCK_MESSAGE[action],
  };
}

function restoreUuidFromOpenimUserId(openimUserId: string) {
  if (!HYPHENLESS_UUID_RE.test(openimUserId)) return null;
  const id = openimUserId.toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(
    16,
    20,
  )}-${id.slice(20)}`;
}

function getOpenimUserIdCandidates(openimUserId: string) {
  const trimmed = openimUserId.trim();
  const restored = restoreUuidFromOpenimUserId(trimmed);
  return Array.from(new Set(restored ? [trimmed, restored] : [trimmed]));
}

@Injectable()
export class CreditPolicyService {
  private readonly openimSendPolicyCache = new Map<
    string,
    OpenimSendPolicyCacheEntry
  >();

  constructor(private readonly prisma: PrismaService) {}

  async check(
    userId: string,
    input: CreditPolicyCheckInput,
  ): Promise<CreditPolicyDecision> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, creditScore: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return buildCreditPolicyDecision(input.action, user.creditScore);
  }

  async checkOpenimSend(
    openimUserId: string,
  ): Promise<CreditPolicyDecision | null> {
    const candidates = getOpenimUserIdCandidates(openimUserId);
    if (candidates.length === 0 || !candidates[0]) {
      return null;
    }

    const cacheKey = candidates[0];
    const cached = this.openimSendPolicyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.decision;
    }

    const user = await this.prisma.user.findFirst({
      where: { OR: candidates.map((id) => ({ id })) },
      select: { id: true, creditScore: true },
    });
    if (!user) {
      return null;
    }

    const decision = buildCreditPolicyDecision(
      CreditPolicyAction.SEND_MESSAGE,
      user.creditScore,
    );
    this.openimSendPolicyCache.set(cacheKey, {
      userId: user.id,
      decision,
      expiresAt: Date.now() + OPENIM_SEND_POLICY_CACHE_TTL_MS,
    });
    return decision;
  }

  invalidateUserPolicyCache(userId: string) {
    for (const [key, entry] of this.openimSendPolicyCache) {
      if (entry.userId === userId) {
        this.openimSendPolicyCache.delete(key);
      }
    }
  }
}
