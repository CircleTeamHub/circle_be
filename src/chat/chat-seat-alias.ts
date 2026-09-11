import type { Prisma } from 'src/generated/prisma';

/**
 * 群昵称(ChatMember.alias,对全群可见)的批量读取。
 *
 * 它按**座位**存 —— 同一个人在 A 群叫「小王」、在 B 群叫「王工」 —— 所以读路径
 * 的键必须是 (会话, 用户) 而不是用户。消息气泡、群日志、系统提示都要它,
 * 抽成一份免得每个服务各写一遍 OR 分支。
 */
export interface SeatRef {
  conversationId: string;
  userId: string;
}

/** Map 的键:别在别处手拼字符串。 */
export function seatKey(conversationId: string, userId: string): string {
  return `${conversationId}:${userId}`;
}

export type SeatAliasClient = Pick<Prisma.TransactionClient, 'chatMember'>;

/**
 * (会话, 用户) → 群昵称,一次查完。只取设了昵称的座位(没设的就是「用账号昵称」,
 * 不必占返回);按会话分组成 OR 分支,分支数正比于会话数而不是消息数。
 */
export async function loadSeatAliases(
  prisma: SeatAliasClient,
  refs: ReadonlyArray<SeatRef>,
): Promise<Map<string, string>> {
  const byConversation = new Map<string, Set<string>>();
  for (const ref of refs) {
    const users = byConversation.get(ref.conversationId) ?? new Set<string>();
    users.add(ref.userId);
    byConversation.set(ref.conversationId, users);
  }
  if (byConversation.size === 0) return new Map();
  const seats = await prisma.chatMember.findMany({
    where: {
      alias: { not: null },
      OR: [...byConversation].map(([conversationID, users]) => ({
        conversationID,
        userID: { in: [...users] },
      })),
    },
    select: { conversationID: true, userID: true, alias: true },
  });
  return new Map(
    seats.flatMap((seat) =>
      typeof seat.alias === 'string'
        ? [[seatKey(seat.conversationID, seat.userID), seat.alias] as const]
        : [],
    ),
  );
}
