import { Prisma } from 'src/generated/prisma';

type UserRelationshipLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Serializes authorization decisions with relationship and privacy changes.
 *
 * The `call-user:*` namespace is shared with FriendService and CallService.
 * Always acquire multiple users in stable order so cross-feature transactions
 * cannot deadlock by requesting the same pair in opposite directions.
 */
export async function lockUserRelationshipState(
  client: UserRelationshipLockClient,
  userIds: string[],
): Promise<void> {
  const orderedIds = [...new Set(userIds)].sort((a, b) => a.localeCompare(b));
  for (const userId of orderedIds) {
    await client.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`call-user:${userId}`}, 0))
    `;
  }
}
