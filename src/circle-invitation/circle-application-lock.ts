import { Prisma } from 'src/generated/prisma';

export function circleApplicationLockKey(
  circleId: string,
  applicantId: string,
): string {
  return `circle-invite:${circleId}:${applicantId}`;
}

export function circleCapacityLockKey(circleId: string): string {
  return `circle-capacity:${circleId}`;
}

export async function lockCircleCapacity(
  tx: Prisma.TransactionClient,
  circleId: string,
): Promise<void> {
  const capacityKey = circleCapacityLockKey(circleId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${capacityKey}))`;
}

export async function lockCircleApplicationPairs(
  tx: Prisma.TransactionClient,
  circleId: string,
  userIds: string[],
): Promise<void> {
  const pairKeys = [...new Set(userIds)]
    .map((userId) => circleApplicationLockKey(circleId, userId))
    // eslint-disable-next-line sonarjs/no-alphabetical-sort
    .sort();
  if (pairKeys.length === 0) return;

  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(pairs.pair_key))
    FROM unnest(ARRAY[${Prisma.join(pairKeys)}]::text[]) AS pairs(pair_key)
    ORDER BY pairs.pair_key
  `;
}
