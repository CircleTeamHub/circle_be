import { Prisma } from 'src/generated/prisma';

type UserRelationshipLockClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

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
  if (orderedIds.length === 0) return;
  // One statement for every key instead of one round trip per user (a 200-member
  // group used to send 200 lock statements while holding its transaction open).
  // Keys and hashing are unchanged, so FriendService / CallService still contend
  // on the same locks. PostgreSQL evaluates volatile output expressions after the
  // ORDER BY sort, so the locks are still taken one by one in `ord` order.
  const keys = orderedIds.map((userId) => `call-user:${userId}`);
  await client.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(lock.key, 0))
    FROM unnest(${keys}::text[]) WITH ORDINALITY AS lock(key, ord)
    ORDER BY lock.ord
  `;
}
