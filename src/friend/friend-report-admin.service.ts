import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendReportStatus, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreditService } from 'src/credit/credit.service';
import { NotificationService } from 'src/notification/notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  FriendReportAdminItemDto,
  FriendReportListDto,
  FriendReportUserDto,
  ReviewFriendReportDto,
} from './dto/friend-report-admin.dto';

// Credit deducted from the target when a report is approved. Kept in sync with
// the historical FRIEND_REPORT deduction so approvals match the old behavior.
const FRIEND_REPORT_CREDIT_DEDUCTION = 5;

const DEFAULT_PAGE_SIZE = 50;

// Review-outcome notification copy (system notifications; identities not
// revealed to the other party).
const NOTIFY_REPORTER_APPROVED = '你举报的用户已被核实处理，感谢反馈。';
const NOTIFY_REPORTER_REJECTED = '你提交的举报经核实未通过。';
const NOTIFY_TARGET_PENALIZED = `你的信誉分因一次被核实的举报下降了 ${FRIEND_REPORT_CREDIT_DEDUCTION} 分。`;

const REPORT_USER_SELECT = {
  id: true,
  nickname: true,
  avatarUrl: true,
  accountId: true,
} as const;

const reportInclude = {
  reporter: { select: REPORT_USER_SELECT },
  target: { select: REPORT_USER_SELECT },
  reviewedBy: { select: REPORT_USER_SELECT },
} as const;

type ReportWithRelations = Prisma.FriendReportGetPayload<{
  include: typeof reportInclude;
}>;

@Injectable()
export class FriendReportAdminService {
  private readonly logger = new Logger(FriendReportAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
    private readonly notificationService: NotificationService,
    private readonly realtimeService: RealtimeService,
  ) {}

  async listReports(
    status: FriendReportStatus = FriendReportStatus.PENDING,
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<FriendReportListDto> {
    const skip = (page - 1) * limit;
    const [reports, total] = await Promise.all([
      this.prisma.friendReport.findMany({
        where: { status },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: reportInclude,
      }),
      this.prisma.friendReport.count({ where: { status } }),
    ]);
    return {
      items: reports.map((report) => this.toDto(report)),
      total,
      page,
      limit,
      hasMore: skip + reports.length < total,
    };
  }

  async reviewReport(
    adminId: string,
    reportId: string,
    dto: ReviewFriendReportDto,
  ): Promise<FriendReportAdminItemDto> {
    const report = await this.prisma.friendReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        status: true,
        reporterID: true,
        targetID: true,
        category: true,
      },
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    if (report.status !== FriendReportStatus.PENDING) {
      throw new ConflictException('Report already reviewed');
    }

    const approve = dto.decision === 'APPROVE';
    const note = dto.note?.trim() || null;

    const applied = await this.prisma.$transaction(async (tx) => {
      // Conditional update doubles as an optimistic lock: only the review that
      // flips PENDING wins, so two admins reviewing at once can't both apply.
      const updated = await tx.friendReport.updateMany({
        where: { id: reportId, status: FriendReportStatus.PENDING },
        data: {
          status: approve
            ? FriendReportStatus.APPROVED
            : FriendReportStatus.REJECTED,
          reviewedByID: adminId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });
      if (updated.count === 0) {
        return false;
      }
      if (approve) {
        await this.creditService.applyDeltaInTransaction(tx, {
          userId: report.targetID,
          delta: -FRIEND_REPORT_CREDIT_DEDUCTION,
          reason: 'FRIEND_REPORT',
          sourceType: 'FRIEND_REPORT',
          sourceId: report.id,
          actorId: adminId,
          idempotencyKey: `friend-report:${report.id}`,
          metadata: { category: report.category },
        });
      }
      return true;
    });

    if (!applied) {
      throw new ConflictException('Report already reviewed');
    }

    if (approve) {
      await this.creditService.broadcastCreditProfileChanged(report.targetID);
    }

    await this.notifyReviewOutcome(report.reporterID, report.targetID, approve);

    this.logger.warn(
      `Friend report ${reportId} ${approve ? 'approved' : 'rejected'} by admin ${adminId}`,
    );

    return this.getReportDto(reportId);
  }

  // Post-commit, best-effort review-outcome notifications. A notification
  // failure must never fail an already-committed review, so results are
  // settled and errors only logged. The reporter always hears the outcome; the
  // target is told only when approved (their score changed).
  private async notifyReviewOutcome(
    reporterId: string,
    targetId: string,
    approve: boolean,
  ): Promise<void> {
    const tasks = [
      this.notifySystemOutcome(
        reporterId,
        approve ? NOTIFY_REPORTER_APPROVED : NOTIFY_REPORTER_REJECTED,
      ),
    ];
    if (approve) {
      tasks.push(this.notifySystemOutcome(targetId, NOTIFY_TARGET_PENALIZED));
    }

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `failed to send report-review notification: ${String(result.reason)}`,
        );
      }
    }
  }

  /**
   * 单个收件人的系统通知：建记录 + 实时广播（与 coin/membership 同一套路），
   * 让「我的」tab 红点即时亮起，不用等快照兜底。广播失败不影响已提交的审核。
   */
  private async notifySystemOutcome(
    userId: string,
    content: string,
  ): Promise<void> {
    const notification =
      await this.notificationService.createSystemNotification(
        userId,
        userId,
        content,
      );
    await this.realtimeService.safeBroadcastAll([
      () =>
        this.realtimeService.broadcastSystemNotificationCreated(
          userId,
          content,
        ),
      ...(notification
        ? [
            () =>
              this.realtimeService.broadcastNotificationCreated(
                userId,
                notification,
              ),
          ]
        : []),
      () => this.realtimeService.broadcastSystemNotificationUnread(userId),
    ]);
  }

  private async getReportDto(
    reportId: string,
  ): Promise<FriendReportAdminItemDto> {
    const report = await this.prisma.friendReport.findUnique({
      where: { id: reportId },
      include: reportInclude,
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    return this.toDto(report);
  }

  private toDto(report: ReportWithRelations): FriendReportAdminItemDto {
    return {
      id: report.id,
      category: report.category,
      description: report.description,
      evidence: report.evidence,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      reviewedAt: report.reviewedAt?.toISOString() ?? null,
      reviewNote: report.reviewNote,
      reporter: this.toUserDto(report.reporter),
      target: this.toUserDto(report.target),
      reviewedBy: report.reviewedBy ? this.toUserDto(report.reviewedBy) : null,
    };
  }

  private toUserDto(user: {
    id: string;
    nickname: string | null;
    avatarUrl: string | null;
    accountId: string;
  }): FriendReportUserDto {
    return {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      accountId: user.accountId,
    };
  }
}
