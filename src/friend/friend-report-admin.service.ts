import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendReportStatus, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreditService } from 'src/credit/credit.service';
import {
  FriendReportAdminItemDto,
  FriendReportUserDto,
  ReviewFriendReportDto,
} from './dto/friend-report-admin.dto';

// Credit deducted from the target when a report is approved. Kept in sync with
// the historical FRIEND_REPORT deduction so approvals match the old behavior.
const FRIEND_REPORT_CREDIT_DEDUCTION = 5;

// Most recent reports returned per status page. Reviewing is low-volume, so a
// simple capped list avoids pagination machinery for now.
const REPORT_LIST_LIMIT = 200;

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
  ) {}

  async listReports(
    status: FriendReportStatus = FriendReportStatus.PENDING,
  ): Promise<FriendReportAdminItemDto[]> {
    const reports = await this.prisma.friendReport.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: REPORT_LIST_LIMIT,
      include: reportInclude,
    });
    return reports.map((report) => this.toDto(report));
  }

  async reviewReport(
    adminId: string,
    reportId: string,
    dto: ReviewFriendReportDto,
  ): Promise<FriendReportAdminItemDto> {
    const report = await this.prisma.friendReport.findUnique({
      where: { id: reportId },
      select: { id: true, status: true, targetID: true, category: true },
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

    this.logger.warn(
      `Friend report ${reportId} ${approve ? 'approved' : 'rejected'} by admin ${adminId}`,
    );

    return this.getReportDto(reportId);
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
