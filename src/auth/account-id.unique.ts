import { ServiceUnavailableException } from '@nestjs/common';
import { generateAccountId } from 'src/utils/account-id';
import { Prisma } from 'src/generated/prisma';

type AccountIdGenerator = () => string;

interface AccountIdLookup {
  user: {
    findUnique(args: {
      where: { accountId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

interface RegistrationCodeLookup extends AccountIdLookup {
  user: AccountIdLookup['user'] & {
    findUnique(args: {
      where: { inviteCode: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

export const REGISTRATION_CODE_MAX_ATTEMPTS = 10;
const MAX_ATTEMPTS = REGISTRATION_CODE_MAX_ATTEMPTS;

function uniqueCollisionTargets(error: unknown): string[] {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return [];
  }
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target : [target];
  return fields.map((field) => String(field ?? ''));
}

export function isRegistrationCodeUniqueCollision(error: unknown): boolean {
  return uniqueCollisionTargets(error).some(
    (target) => target.includes('accountId') || target.includes('inviteCode'),
  );
}

export function isInviteCodeUniqueCollision(error: unknown): boolean {
  return uniqueCollisionTargets(error).some((target) =>
    target.includes('inviteCode'),
  );
}

/**
 * 生成一个数据库内唯一的 accountId。复用纯随机生成器 generateAccountId()，
 * 碰撞则重试；MAX_ATTEMPTS 次仍冲突视为异常（概率极低，通常是 DB 故障）。
 */
export async function generateUniqueAccountId(
  prisma: AccountIdLookup,
  generate: AccountIdGenerator = generateAccountId,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generate();
    const existing = await prisma.user.findUnique({
      where: { accountId: candidate },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
  }
  // 10 次随机候选全部撞库概率极低，真发生通常意味着 DB 异常。抛 503 而非裸
  // Error，让全局过滤器返回干净的 5xx，且语义上是"暂时不可用、可重试"。
  throw new ServiceUnavailableException(
    'Failed to generate a unique account ID',
  );
}

/** Generates a value that is free in both mutable account IDs and invite codes. */
export async function generateUniqueRegistrationCode(
  prisma: RegistrationCodeLookup,
  generate: AccountIdGenerator = generateAccountId,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generate();
    const [account, invite] = await Promise.all([
      prisma.user.findUnique({
        where: { accountId: candidate },
        select: { id: true },
      }),
      prisma.user.findUnique({
        where: { inviteCode: candidate },
        select: { id: true },
      }),
    ]);
    if (!account && !invite) return candidate;
  }

  throw new ServiceUnavailableException(
    'Failed to generate a unique registration code',
  );
}
