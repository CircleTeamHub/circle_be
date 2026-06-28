import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from 'src/icon/icon.service';
import { likedOnToday } from './like.util';
import { LikeStatusDto } from './dto/like-status.dto';

// 每人每天最多给几个不同的人点赞（防刷）。随时可改。
const DAILY_LIKE_LIMIT = 5;
// Serializable 事务在并发冲突时会抛 P2034，重试几次以吸收良性并发（多设备同时点赞）。
const SERIALIZATION_RETRIES = 3;

/** 当日配额已满的内部信号（事务内抛出以回滚），在 like() 边界转成 400。 */
class DailyLikeLimitError extends Error {}

@Injectable()
export class LikeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly iconService: IconService,
  ) {}

  /**
   * 给 toUserId 点赞：对同一目标每天最多一次；且每人每天最多给
   * DAILY_LIKE_LIMIT 个不同的人点赞。重复点同一人幂等（不占配额）。
   */
  async like(fromUserId: string, toUserId: string): Promise<LikeStatusDto> {
    if (fromUserId === toUserId) {
      throw new BadRequestException('不能给自己点赞');
    }

    // 目标必须存在且为活跃用户：不能给已封禁/已注销的账号刷赞、刷徽章。
    const target = await this.prisma.user.findUnique({
      where: { id: toUserId },
      select: { status: true },
    });
    if (!target || target.status !== UserStatus.ACTIVE) {
      throw new NotFoundException('用户不存在或不可用');
    }

    const likedOn = likedOnToday();

    // 今天已经赞过 ta：幂等返回，不占用新的每日配额。
    const existing = await this.prisma.userLike.findUnique({
      where: {
        fromUserID_toUserID_likedOn: {
          fromUserID: fromUserId,
          toUserID: toUserId,
          likedOn,
        },
      },
    });
    if (existing) {
      return this.getStatus(fromUserId, toUserId);
    }

    try {
      await this.createLikeAtomically(fromUserId, toUserId, likedOn);
      // 被赞数可能跨过阈值新获得合作达人徽章 → 失效其图标缓存。
      this.iconService.invalidateDisplayIconCacheFor(toUserId);
    } catch (e) {
      if (e instanceof DailyLikeLimitError) {
        throw new BadRequestException(
          `今天点赞次数已达上限（每天最多给 ${DAILY_LIKE_LIMIT} 个人点赞）`,
        );
      }
      // 并发下同一目标二次创建 = 唯一约束冲突（P2002），幂等：忽略。
      if ((e as { code?: string }).code !== 'P2002') {
        throw e;
      }
    }

    return this.getStatus(fromUserId, toUserId);
  }

  /**
   * 在一个 Serializable 事务里「校验当日配额 → 建点赞 → 计数 +1」，三步原子。
   * Serializable 让并发点赞被串行化，杜绝 count-then-create 的 TOCTOU 越限。
   */
  private async createLikeAtomically(
    fromUserId: string,
    toUserId: string,
    likedOn: Date,
  ): Promise<void> {
    for (let attempt = 0; attempt < SERIALIZATION_RETRIES; attempt += 1) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const todayCount = await tx.userLike.count({
              where: { fromUserID: fromUserId, likedOn },
            });
            if (todayCount >= DAILY_LIKE_LIMIT) {
              throw new DailyLikeLimitError();
            }
            await tx.userLike.create({
              data: { fromUserID: fromUserId, toUserID: toUserId, likedOn },
            });
            await tx.user.update({
              where: { id: toUserId },
              data: { receivedLikeCount: { increment: 1 } },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return;
      } catch (e) {
        // P2034 = 序列化冲突，良性并发，重试。
        if ((e as { code?: string }).code === 'P2034') {
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException('操作太频繁，请稍后重试');
  }

  /** 取消今天对 toUserId 的点赞（仅当天那一条）。删除与计数原子。 */
  async unlike(fromUserId: string, toUserId: string): Promise<LikeStatusDto> {
    const likedOn = likedOnToday();

    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.userLike.deleteMany({
        where: { fromUserID: fromUserId, toUserID: toUserId, likedOn },
      });
      if (count > 0) {
        // GREATEST(...,0) 给去归一化计数兜底，任何漂移都不会让它变负。
        await tx.$executeRaw`UPDATE "User" SET "receivedLikeCount" = GREATEST("receivedLikeCount" - 1, 0) WHERE "id" = ${toUserId}`;
      }
      return count;
    });

    if (removed > 0) {
      this.iconService.invalidateDisplayIconCacheFor(toUserId);
    }

    return this.getStatus(fromUserId, toUserId);
  }

  /** 资料页 / 点赞后返回：目标被赞总数 + 我今天赞过没。 */
  async getStatus(viewerId: string, targetId: string): Promise<LikeStatusDto> {
    const [target, mine] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: targetId },
        select: { receivedLikeCount: true },
      }),
      viewerId === targetId
        ? Promise.resolve(null)
        : this.prisma.userLike.findUnique({
            where: {
              fromUserID_toUserID_likedOn: {
                fromUserID: viewerId,
                toUserID: targetId,
                likedOn: likedOnToday(),
              },
            },
          }),
    ]);

    return {
      likeCount: target?.receivedLikeCount ?? 0,
      likedByMeToday: Boolean(mine),
    };
  }
}
