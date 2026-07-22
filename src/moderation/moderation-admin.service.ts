import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CirclePostStatus, ReportReviewStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';

const PAGE_LIMIT_MAX = 100;

type AuditContext = { ip?: string | null; userAgent?: string | null };

/**
 * 内容治理（#92 / #93）：让群报告与圈子帖子报告可被 action，并给运营
 * 「删帖/恢复」这把比封号细的手术刀。全部动作写 AdminAuditLog（#90）。
 */
@Injectable()
export class ModerationAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  // ─── 报告清单 ────────────────────────────────────────────────────────────────

  async listGroupReports(status: ReportReviewStatus, page = 1, limit = 20) {
    const take = Math.min(limit, PAGE_LIMIT_MAX);
    const [items, total] = await Promise.all([
      this.prisma.groupReport.findMany({
        where: { status },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * take,
        take,
        include: {
          reporter: { select: { id: true, nickname: true, accountId: true } },
          circle: { select: { id: true, name: true } },
        },
      }),
      this.prisma.groupReport.count({ where: { status } }),
    ]);
    return { items, total, page, limit: take };
  }

  async listPostReports(status: ReportReviewStatus, page = 1, limit = 20) {
    const take = Math.min(limit, PAGE_LIMIT_MAX);
    const [items, total] = await Promise.all([
      this.prisma.circlePostReport.findMany({
        where: { status },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.circlePostReport.count({ where: { status } }),
    ]);
    return { items, total, page, limit: take };
  }

  // ─── 报告审核 ────────────────────────────────────────────────────────────────

  async reviewGroupReport(
    actorID: string,
    reportId: string,
    dto: { approve: boolean; note?: string },
    context: AuditContext = {},
  ) {
    const report = await this.prisma.groupReport.findUnique({
      where: { id: reportId },
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    const status = dto.approve
      ? ReportReviewStatus.APPROVED
      : ReportReviewStatus.REJECTED;
    // review 修复（原子认领）：条件写只让一个管理员完成 PENDING→终态转换。
    // 读-查-写下两位管理员并发审同一单会互相覆盖结论/备注并留下矛盾审计。
    const claimed = await this.prisma.groupReport.updateMany({
      where: { id: reportId, status: ReportReviewStatus.PENDING },
      data: {
        status,
        reviewedByID: actorID,
        reviewedAt: new Date(),
        reviewNote: dto.note ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('Report already reviewed');
    }
    const updated = await this.prisma.groupReport.findUniqueOrThrow({
      where: { id: reportId },
    });
    await this.audit.record({
      actorID,
      action: 'group_report_review',
      entityType: 'GroupReport',
      entityID: reportId,
      before: { status: report.status },
      after: { status, note: dto.note ?? null },
      ...context,
    });
    return updated;
  }

  async reviewPostReport(
    actorID: string,
    reportId: string,
    dto: { approve: boolean; note?: string },
    context: AuditContext = {},
  ) {
    const report = await this.prisma.circlePostReport.findUnique({
      where: { id: reportId },
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    const status = dto.approve
      ? ReportReviewStatus.APPROVED
      : ReportReviewStatus.REJECTED;
    // review 修复（原子认领）：条件写只让一个管理员完成 PENDING→终态转换。
    // 读-查-写下两位管理员并发审同一单会互相覆盖结论/备注并留下矛盾审计。
    const claimed = await this.prisma.circlePostReport.updateMany({
      where: { id: reportId, status: ReportReviewStatus.PENDING },
      data: {
        status,
        reviewedByID: actorID,
        reviewedAt: new Date(),
        reviewNote: dto.note ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('Report already reviewed');
    }
    const updated = await this.prisma.circlePostReport.findUniqueOrThrow({
      where: { id: reportId },
    });
    await this.audit.record({
      actorID,
      action: 'post_report_review',
      entityType: 'CirclePostReport',
      entityID: reportId,
      before: { status: report.status },
      after: { status, note: dto.note ?? null },
      ...context,
    });
    return updated;
  }

  // ─── 内容下架 / 恢复（#93）────────────────────────────────────────────────────

  async takedownPost(
    actorID: string,
    postId: string,
    note: string | undefined,
    context: AuditContext = {},
  ) {
    const post = await this.prisma.circlePost.findUnique({
      where: { id: postId },
      select: { id: true, status: true, authorID: true, circleID: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.status === CirclePostStatus.DELETED) {
      return { id: post.id, status: post.status };
    }
    // review 修复：下架必须走与 CirclePlazaService.deletePost 相同的计数
    // 维护 —— 否则每个关联圈子的 postCount 永久虚高，恢复也无从补偿。
    // CAS（非 DELETED → DELETED）保证并发/重试只扣一次。
    const linkedCircleIds = await this.linkedCircleIds(postId, post.circleID);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.circlePost.updateMany({
        where: { id: postId, status: { not: CirclePostStatus.DELETED } },
        data: { status: CirclePostStatus.DELETED },
      });
      if (claimed.count !== 1) return;
      await tx.circle.updateMany({
        where: { id: { in: linkedCircleIds } },
        data: { postCount: { decrement: 1 } },
      });
    });
    const updated = { id: postId, status: CirclePostStatus.DELETED };
    await this.audit.record({
      actorID,
      action: 'post_takedown',
      entityType: 'CirclePost',
      entityID: postId,
      before: { status: post.status },
      after: { status: CirclePostStatus.DELETED, note: note ?? null },
      ...context,
    });
    return updated;
  }

  /** 帖子关联的全部圈子 id（含主圈子）——postCount 增减的作用域。 */
  private async linkedCircleIds(
    postId: string,
    primaryCircleID: string,
  ): Promise<string[]> {
    const links = await this.prisma.circlePostCircle.findMany({
      where: { postID: postId },
      select: { circleID: true },
    });
    return links.length
      ? [...new Set(links.map((link) => link.circleID))]
      : [primaryCircleID];
  }

  /**
   * 当前 DELETED 状态是否归因于管理端下架：最近一次 post_takedown 审计晚于
   * 最近一次 post_restore。作者自删不写审计，天然返回 false。
   */
  private async wasTakenDownByModeration(postId: string): Promise<boolean> {
    const [lastTakedown, lastRestore] = await Promise.all([
      this.prisma.adminAuditLog.findFirst({
        where: {
          entityType: 'CirclePost',
          entityID: postId,
          action: 'post_takedown',
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.adminAuditLog.findFirst({
        where: {
          entityType: 'CirclePost',
          entityID: postId,
          action: 'post_restore',
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    if (!lastTakedown) return false;
    if (!lastRestore) return true;
    return lastTakedown.createdAt > lastRestore.createdAt;
  }

  async restorePost(
    actorID: string,
    postId: string,
    context: AuditContext = {},
  ) {
    const post = await this.prisma.circlePost.findUnique({
      where: { id: postId },
      select: { id: true, status: true, circleID: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.status !== CirclePostStatus.DELETED) {
      return { id: post.id, status: post.status };
    }
    // review 修复：作者自删与管理端下架共用 DELETED——只有当前 DELETED 状态
    // 「归因于管理端下架」（最近一次 post_takedown 晚于最近一次 post_restore）
    // 才可恢复；否则等于管理员替作者反悔，把用户主动删除的内容重新公开。
    const takenDownByModeration = await this.wasTakenDownByModeration(postId);
    if (!takenDownByModeration) {
      throw new ConflictException(
        'Post was deleted by its author, not by moderation — refusing to restore',
      );
    }
    // 恢复到 ENDED 而不是 ACTIVE：下架期间报名窗口早过了，直接回 ACTIVE 会
    // 让一个陈年帖子重新出现在「进行中」流里。ENDED 可见但不可再报名。
    // 计数对称回补下架时的递减。
    const linkedCircleIds = await this.linkedCircleIds(postId, post.circleID);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.circlePost.updateMany({
        where: { id: postId, status: CirclePostStatus.DELETED },
        data: { status: CirclePostStatus.ENDED },
      });
      if (claimed.count !== 1) return;
      await tx.circle.updateMany({
        where: { id: { in: linkedCircleIds } },
        data: { postCount: { increment: 1 } },
      });
    });
    const updated = { id: postId, status: CirclePostStatus.ENDED };
    await this.audit.record({
      actorID,
      action: 'post_restore',
      entityType: 'CirclePost',
      entityID: postId,
      before: { status: post.status },
      after: { status: CirclePostStatus.ENDED },
      ...context,
    });
    return updated;
  }
}
