import { GroupSyncOperation, Prisma } from 'src/generated/prisma';

const OPEN_GROUP_SYNC_STATUSES = ['PENDING', 'PROCESSING', 'FAILED'] as const;

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
      status: { in: [...OPEN_GROUP_SYNC_STATUSES] },
    },
    data: {
      status: 'COMPLETED',
      processedAt: new Date(),
      lockedAt: null,
      lastError: `Superseded by desired ${operation} state`,
    },
  });
  await tx.groupSyncOutbox.createMany({
    data: userIDs.map((userID) => ({ operation, groupID, userID })),
    skipDuplicates: true,
  });
}
