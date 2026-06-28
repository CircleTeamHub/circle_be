import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from 'src/icon/icon.service';
import { likedOnToday } from './like.util';
import { LikeStatusDto } from './dto/like-status.dto';

// 每人每天最多给几个不同的人点赞（防刷）。随时可改。
const DAILY_LIKE_LIMIT = 5;

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

    // 每日配额：今天给不同的人点赞最多 DAILY_LIKE_LIMIT 个。
    const todayCount = await this.prisma.userLike.count({
      where: { fromUserID: fromUserId, likedOn },
    });
    if (todayCount >= DAILY_LIKE_LIMIT) {
      throw new BadRequestException(
        `今天点赞次数已达上限（每天最多给 ${DAILY_LIKE_LIMIT} 个人点赞）`,
      );
    }

    try {
      await this.prisma.$transaction([
        this.prisma.userLike.create({
          data: { fromUserID: fromUserId, toUserID: toUserId, likedOn },
        }),
        this.prisma.user.update({
          where: { id: toUserId },
          data: { receivedLikeCount: { increment: 1 } },
        }),
      ]);
      // 被赞数可能跨过阈值新获得合作达人徽章 → 失效其图标缓存。
      this.iconService.invalidateDisplayIconCacheFor(toUserId);
    } catch (e) {
      // 唯一约束冲突（P2002）= 今天已经赞过，幂等：直接返回当前状态。
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }

    return this.getStatus(fromUserId, toUserId);
  }

  /** 取消今天对 toUserId 的点赞（仅当天那一条）。 */
  async unlike(fromUserId: string, toUserId: string): Promise<LikeStatusDto> {
    const likedOn = likedOnToday();
    const { count } = await this.prisma.userLike.deleteMany({
      where: { fromUserID: fromUserId, toUserID: toUserId, likedOn },
    });

    if (count > 0) {
      await this.prisma.user.update({
        where: { id: toUserId },
        data: { receivedLikeCount: { decrement: 1 } },
      });
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
