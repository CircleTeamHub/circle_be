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
  ownerCapacity: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(seatCount) || seatCount < 0) {
    throw new RangeError('seatCount must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(ownerCapacity) || ownerCapacity < 0) {
    throw new RangeError('ownerCapacity must be a non-negative safe integer');
  }
  if (seatCount === 0) {
    return true;
  }

  // 座位受两道上限：圈子存的 maxMembers（创建时按创建者档位定），以及**圈主当前有效会员**的
  // 单群人数配额 ownerCapacity。后者实现软降级——圈主过期/降级后新增被按低配额挡住；legacy
  // maxMembers 为 null 的圈子也由 ownerCapacity 兜底封顶，而非无限。
  const reserved = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Circle"
    SET "memberCount" = "memberCount" + ${seatCount},
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${circleId}
      AND "deleted" = false
      AND (
        "maxMembers" IS NULL
        OR "memberCount" + ${seatCount} <= "maxMembers"
      )
      AND "memberCount" + ${seatCount} <= ${ownerCapacity}
    RETURNING "id"
  `;

  return reserved.length === 1;
}
