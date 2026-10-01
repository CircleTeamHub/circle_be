import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { getRequestContext } from 'src/logging/request-context';

export async function runAdminOperation<T>(
  prisma: PrismaService,
  actorID: string,
  operation: string,
  key: string | undefined,
  payload: object,
  execute: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!key || !/^[0-9a-f-]{36}$/i.test(key))
    throw new BadRequestException('需要有效的 Idempotency-Key');
  const id = createHash('sha256')
    .update(`${actorID}:${operation}:${key}`)
    .digest('hex');
  const inputHash = createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
    const previous = await tx.adminOperationRequest.findUnique({
      where: { id },
    });
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new ConflictException('本次请求内容已变化，请使用新的操作标识');
      return previous.result as T;
    }
    const result = await execute(tx);
    await tx.adminOperationRequest.create({
      data: {
        id,
        actorID,
        inputHash,
        result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
      },
    });
    return result;
  });
}

export function writeOperationAudit(
  tx: Prisma.TransactionClient,
  actorID: string,
  action: string,
  entityType: string,
  entityID: string | undefined,
  reason: string,
  before?: Prisma.InputJsonValue,
  after?: Prisma.InputJsonValue,
) {
  const context = getRequestContext();
  return tx.adminAuditLog.create({
    data: {
      actorID,
      action,
      entityType,
      entityID,
      reason,
      before,
      after,
      requestId: context?.requestId,
      ip: context?.ip?.slice(0, 64),
      userAgent: context?.userAgent?.slice(0, 256),
    },
  });
}
