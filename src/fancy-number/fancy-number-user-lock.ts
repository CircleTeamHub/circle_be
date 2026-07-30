import { Prisma } from 'src/generated/prisma';

const FANCY_NUMBER_USER_LOCK_PREFIX = 'fancy-number-user:';

export async function lockFancyNumberUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${FANCY_NUMBER_USER_LOCK_PREFIX}${userId}`}, 0)
      )
    `,
  );
}
