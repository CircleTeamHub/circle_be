import { GroupSyncOperation, Prisma } from 'src/generated/prisma';

export async function enqueueCircleMemberSync(
  tx: Prisma.TransactionClient,
  operation: GroupSyncOperation,
  groupID: string,
  requestedUserIDs: readonly string[],
): Promise<void> {
  const userIDs = [...new Set(requestedUserIDs)]
    // Keep batch writes deterministic and aligned with membership lock order.
    // eslint-disable-next-line sonarjs/no-alphabetical-sort
    .sort();
  if (userIDs.length === 0) return;

  await tx.groupSyncOutbox.updateMany({
    where: {
      groupID,
      userID: { in: userIDs },
    },
    data: {
      operation,
      generation: { increment: 1 },
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
      processedAt: null,
    },
  });
  await tx.groupSyncOutbox.createMany({
    data: userIDs.map((userID) => ({ operation, groupID, userID })),
    skipDuplicates: true,
  });
}
