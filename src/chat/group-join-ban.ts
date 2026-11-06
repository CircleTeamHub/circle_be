import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from 'src/generated/prisma';

/** Applications/invitations and final admission share the same group-scoped ban. */
export async function assertGroupJoinAllowed(
  tx: Pick<Prisma.TransactionClient, 'chatGroupJoinBan'>,
  where: Prisma.ChatGroupJoinBanWhereInput,
): Promise<void> {
  if (
    await tx.chatGroupJoinBan.findFirst({ where, select: { userID: true } })
  ) {
    throw new ForbiddenException({
      message: '该账号无法加入此群',
      errorCode: 'CHAT_GROUP_JOIN_BLOCKED',
    });
  }
}
