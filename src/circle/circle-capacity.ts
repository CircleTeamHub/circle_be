import { Prisma } from 'src/generated/prisma';

/**
 * Atomically reserves active-member seats and advances the denormalized count.
 * PostgreSQL serializes concurrent updates to the same Circle row, so callers
 * do not need a separate capacity lock or read/check/write sequence.
 */
export async function reserveCircleSeats(
  tx: Prisma.TransactionClient,
  circleId: string,
  seatCount: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(seatCount) || seatCount < 0) {
    throw new RangeError('seatCount must be a non-negative safe integer');
  }
  if (seatCount === 0) {
    return true;
  }

  const reserved = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Circle"
    SET "memberCount" = "memberCount" + ${seatCount},
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${circleId}
      AND (
        "maxMembers" IS NULL
        OR "memberCount" + ${seatCount} <= "maxMembers"
      )
    RETURNING "id"
  `;

  return reserved.length === 1;
}
