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
    if (report.status !== ReportReviewStatus.PENDING) {
      throw new ConflictException('Report already reviewed');
    }
    const status = dto.approve
      ? ReportReviewStatus.APPROVED
      : ReportReviewStatus.REJECTED;
    const updated = await this.prisma.groupReport.update({
      where: { id: reportId },
      data: {
        status,
        reviewedByID: actorID,
        reviewedAt: new Date(),
        reviewNote: dto.note ?? null,
      },
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
    if (report.status !== ReportReviewStatus.PENDING) {
      throw new ConflictException('Report already reviewed');
    }
    const status = dto.approve
      ? ReportReviewStatus.APPROVED
      : ReportReviewStatus.REJECTED;
    const updated = await this.prisma.circlePostReport.update({
      where: { id: reportId },
      data: {
        status,
        reviewedByID: actorID,
        reviewedAt: new Date(),
        reviewNote: dto.note ?? null,
      },
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
      select: { id: true, status: true, authorID: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.status === CirclePostStatus.DELETED) {
      return { id: post.id, status: post.status };
    }
    const updated = await this.prisma.circlePost.update({
      where: { id: postId },
      data: { status: CirclePostStatus.DELETED },
      select: { id: true, status: true },
    });
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

  async restorePost(
    actorID: string,
    postId: string,
    context: AuditContext = {},
  ) {
    const post = await this.prisma.circlePost.findUnique({
      where: { id: postId },
      select: { id: true, status: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.status !== CirclePostStatus.DELETED) {
      return { id: post.id, status: post.status };
    }
    // 恢复到 ENDED 而不是 ACTIVE：下架期间报名窗口早过了，直接回 ACTIVE 会
    // 让一个陈年帖子重新出现在「进行中」流里。ENDED 可见但不可再报名。
    const updated = await this.prisma.circlePost.update({
      where: { id: postId },
      data: { status: CirclePostStatus.ENDED },
      select: { id: true, status: true },
    });
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
