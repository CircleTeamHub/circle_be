import { ServiceUnavailableException } from '@nestjs/common';
import { generateAccountId, generateInviteCode } from 'src/utils/account-id';
import { Prisma } from 'src/generated/prisma';

type AccountIdGenerator = () => string;

interface RegistrationCodeLookup {
  user: {
    findMany(args: {
      where: { accountId: { in: string[] } } | { inviteCode: { in: string[] } };
      select: { accountId: true } | { inviteCode: true };
    }): Promise<
      Array<{ accountId?: string | null; inviteCode?: string | null }>
    >;
  };
  accountIdentifier?: {
    findMany(args: {
      where: { value: { in: string[] } };
      select: { value: true };
    }): Promise<Array<{ value: string }>>;
  };
}

export const REGISTRATION_CODE_MAX_ATTEMPTS = 10;

// 6 位十进制账号只有 100 万个取值。逐个候选、只试 10 次的老策略在半满时就有
// 约 1/1024 的注册直接 503(80% 占用时超过 10%),远早于命名空间真的用尽。
//
// 改成按批取候选:一批 CANDIDATE_BATCH_SIZE 个候选合并成 3 条 IN 查询(而不是
// 32×3 条),命中就立刻返回 —— 空旷时永远只花 1 轮 / 3 条查询。轮次上限按"最坏
// 情况也别提前放弃"来定:1024 个候选在 95% 占用下全撞的概率约 5e-23,99% 占用
// (还剩 1 万个空号)也只有 3e-5;代价只有在真的撞满时才付,而那时候慢一点远好过
// 直接 503。
//
// 再往上(>99% 占用)不该靠加轮次解决:那说明 6 位命名空间本身到头了,要加位数。
const CANDIDATE_BATCH_SIZE = 32;
const CANDIDATE_BATCH_ROUNDS = 32;

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
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
 * User_account_identifier_prepare 触发器在标识符被别人占用时 `RAISE EXCEPTION
 * 'account identifier collision: <value>'`。它走的是 plpgsql 的 P0001,不是
 * Prisma 的 P2002,所以必须单独识别 —— 否则并发注册撞到同一个候选值时,输的那
 * 边会以未分类的 500 结束,而不是走上层的换码重试。
 */
export function isAccountIdentifierClaimCollision(
  error: unknown,
  values: Array<string | null | undefined>,
): boolean {
  const message = errorMessage(error).toLowerCase();
  return values.some(
    (value) =>
      !!value &&
      message.includes(`account identifier collision: ${value.toLowerCase()}`),
  );
}

/** Collects a de-duplicated batch of candidates in their stored casing. */
function collectCandidates(
  generate: AccountIdGenerator,
  format: (raw: string) => string,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < CANDIDATE_BATCH_SIZE; i += 1) {
    const candidate = format(generate());
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/**
 * 返回一个在「可变账号 / 邀请码 / 靓号库」三处都空闲的候选值(按 format 决定的
 * 存储大小写返回)。AccountIdentifier 是三个命名空间共用的小写规范登记表,所以
 * 三处都按小写规范值比对。
 */
async function findFreeCandidate(
  prisma: RegistrationCodeLookup,
  generate: AccountIdGenerator,
  format: (raw: string) => string,
): Promise<string | null> {
  for (let round = 0; round < CANDIDATE_BATCH_ROUNDS; round += 1) {
    const candidates = collectCandidates(generate, format);
    const canonical = candidates.map((candidate) => candidate.toLowerCase());
    const upper = candidates.map((candidate) => candidate.toUpperCase());
    const [accounts, invites, identifiers] = await Promise.all([
      prisma.user.findMany({
        where: { accountId: { in: canonical } },
        select: { accountId: true },
      }),
      prisma.user.findMany({
        where: { inviteCode: { in: upper } },
        select: { inviteCode: true },
      }),
      prisma.accountIdentifier
        ? prisma.accountIdentifier.findMany({
            where: { value: { in: canonical } },
            select: { value: true },
          })
        : Promise.resolve([]),
    ]);
    const taken = new Set<string>();
    for (const row of accounts) {
      if (row.accountId) taken.add(row.accountId.toLowerCase());
    }
    for (const row of invites) {
      if (row.inviteCode) taken.add(row.inviteCode.toLowerCase());
    }
    for (const row of identifiers) taken.add(row.value.toLowerCase());

    const free = candidates.find(
      (candidate) => !taken.has(candidate.toLowerCase()),
    );
    if (free) return free;
  }
  return null;
}

/** Generates a numeric account ID that is free across all three namespaces. */
export async function generateUniqueAccountId(
  prisma: RegistrationCodeLookup,
  generate: AccountIdGenerator = generateAccountId,
): Promise<string> {
  const candidate = await findFreeCandidate(prisma, generate, (raw) =>
    raw.toLowerCase(),
  );
  if (candidate) return candidate;
  // 4×32 个候选全部撞库,说明命名空间接近枯竭(或 DB 异常)。抛 503 而非裸
  // Error,让全局过滤器返回干净的 5xx,且语义上是"暂时不可用、可重试"。
  throw new ServiceUnavailableException(
    'Failed to generate a unique account ID',
  );
}

/** Generates a value that is free in both mutable account IDs and invite codes. */
export async function generateUniqueRegistrationCode(
  prisma: RegistrationCodeLookup,
  generate: AccountIdGenerator = generateInviteCode,
): Promise<string> {
  const candidate = await findFreeCandidate(prisma, generate, (raw) =>
    raw.toUpperCase(),
  );
  if (candidate) return candidate;

  throw new ServiceUnavailableException(
    'Failed to generate a unique registration code',
  );
}
