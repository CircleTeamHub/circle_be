import type { Prisma } from 'src/generated/prisma';

/** Caller holds the conversation lock; run before advancing any clear floor. */
export async function startReadBurnTimers(
  tx: Prisma.TransactionClient,
  conversationId: string,
  userId: string,
  height: number,
): Promise<number> {
  const started = await tx.$queryRaw<Array<{ revision: number }>>`
    WITH started AS (UPDATE "ChatMessage" m
    SET "burnExpiresAt" = clock_timestamp() + m."burnDurationSec" * INTERVAL '1 second'
    FROM "ChatConversation" c, "ChatMember" reader
    WHERE m."conversationID" = ${conversationId}
      AND m."height" <= ${height}
      AND reader."userID" = ${userId}
      AND c."id" = m."conversationID" AND c."type" = 'DIRECT'
      AND reader."conversationID" = c."id" AND reader."leftAt" IS NULL
      AND m."height" > GREATEST(reader."clearedBeforeHeight", c."clearedBeforeHeight")
      AND m."senderID" <> reader."userID" AND m."createdAt" >= reader."joinedAt"
      AND m."burnDurationSec" > 0 AND m."burnExpiresAt" IS NULL
      AND m."deleted" = false AND m."revokedAt" IS NULL
    RETURNING m."revision")
    SELECT COALESCE(MAX("revision"), 0)::integer AS revision FROM started`;
  return Math.max(0, ...started.map((row) => row.revision ?? 0));
}
