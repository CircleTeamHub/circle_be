import { generateAccountId } from 'src/utils/account-id';

type AccountIdGenerator = () => string;

interface AccountIdLookup {
  user: {
    findUnique(args: {
      where: { accountId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

const MAX_ATTEMPTS = 10;

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
  throw new Error('Failed to generate a unique account ID');
}
