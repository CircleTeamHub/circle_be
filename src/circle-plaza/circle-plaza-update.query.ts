import type { Prisma } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';

/** 没有 expiresAt 的老帖，发布满这么久算到期。 */
export const CIRCLE_POST_AUTO_END_MS = 24 * 60 * 60 * 1000;

// 圈子成员可见范围：圈子未删除 且 viewer 是该圈 ACTIVE 成员。
// 列表、详情、红点共用同一份圈子范围。会员等级门槛只在列表/详情接口上，
// 客户端收到门槛响应后自己隐藏红点。
export function memberCircleScope(viewerId: string): Prisma.CircleWhereInput {
  return {
    deleted: false,
    members: { some: { userID: viewerId, status: 'ACTIVE' } },
  };
}

export function activeUnexpiredPostWhere(
  now = new Date(),
): Prisma.CirclePostWhereInput {
  const legacyCutoff = new Date(now.getTime() - CIRCLE_POST_AUTO_END_MS);

  return {
    status: 'ACTIVE',
    OR: [
      { expiresAt: { gt: now } },
      {
        expiresAt: null,
        createdAt: { gt: legacyCutoff },
      },
    ],
  };
}

/**
 * 飞机 tab 的红点：上次打开圈子帖子列表之后，列表里有没有别人发的新帖。
 *
 * status='ACTIVE' 的帖子到期就会被定时任务结束，所以即使用户很久没打开，
 * 扫描量也只跟「当前还在进行的帖子」有关，不会随历史累积。
 */
export async function loadCirclePlazaUpdate(
  prisma: Pick<PrismaService, 'user' | 'circlePost' | '$queryRaw'>,
  userId: string,
): Promise<{ hasUpdate: boolean; changedAt: string }> {
  // State versions must advance even when the last unread post expires or is deleted.
  const [clock] = await prisma.$queryRaw<Array<{ observedAt: Date }>>`
    SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "observedAt"
  `;
  const observedAt = clock.observedAt;
  const viewer = await prisma.user.findUnique({
    where: { id: userId },
    select: { circlePlazaSeenAt: true },
  });
  if (!viewer) return { hasUpdate: false, changedAt: observedAt.toISOString() };

  const newerPost = await prisma.circlePost.findFirst({
    where: {
      ...activeUnexpiredPostWhere(observedAt),
      createdAt: { gt: viewer.circlePlazaSeenAt, lte: observedAt },
      authorID: { not: userId },
      circleLinks: { some: { circle: memberCircleScope(userId) } },
    },
    select: { id: true },
  });
  return {
    hasUpdate: newerPost !== null,
    changedAt: observedAt.toISOString(),
  };
}

export async function loadCirclePlazaHasUpdate(
  prisma: Pick<PrismaService, 'user' | 'circlePost' | '$queryRaw'>,
  userId: string,
): Promise<boolean> {
  return (await loadCirclePlazaUpdate(prisma, userId)).hasUpdate;
}
