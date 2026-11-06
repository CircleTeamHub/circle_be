import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { GroupAdmissionService } from 'src/chat/group-admission.service';
import { CircleInvitationService } from './circle-invitation.service';

export type GroupReviewAction = 'approve' | 'reject' | 'blacklist';
export type GroupReviewQuery = {
  cursor?: string;
  keyword?: string;
  limit?: number;
};
type ReviewPerson = {
  id: string;
  nickname: string;
  accountId: string;
  avatarUrl: string | null;
};
type ReviewRow = {
  id: string;
  applicantID: string;
  inviterID: string | null;
  source: string;
  status: string;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  applicantName: string | null;
  applicantAccount: string | null;
  applicantAvatar: string | null;
  inviterName: string | null;
  inviterAccount: string | null;
  inviterAvatar: string | null;
};

@Injectable()
export class GroupReviewService {
  private readonly logger = new Logger(GroupReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admissions: GroupAdmissionService,
    private readonly invitations: CircleInvitationService,
  ) {}

  private async context(actorId: string, conversationId: string) {
    const group = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        type: true,
        circleID: true,
        ownerID: true,
        name: true,
      },
    });
    if (!group || group.type !== 'GROUP')
      throw new NotFoundException('群聊不存在');
    const circle = group.circleID
      ? await this.prisma.circle.findUnique({
          where: { id: group.circleID },
          select: { name: true, deleted: true },
        })
      : null;
    if (group.circleID && (!circle || circle.deleted))
      throw new NotFoundException('群聊不存在');
    const seat = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: actorId,
        },
      },
      select: { role: true, leftAt: true },
    });
    if (!seat || seat.leftAt)
      throw new ForbiddenException({
        message: '不是群成员',
        errorCode: 'CHAT_NOT_MEMBER',
      });
    if (group.circleID) {
      const membership = await this.prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: actorId, circleID: group.circleID },
        },
        select: { role: true, status: true },
      });
      if (
        !membership ||
        membership.status !== 'ACTIVE' ||
        (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
      ) {
        throw new ForbiddenException({
          message: '仅群主和管理员可审核',
          errorCode: 'CHAT_GROUP_MANAGER_ONLY',
        });
      }
    } else {
      if (!group.ownerID) throw new NotFoundException('群聊不存在');
      const owner =
        group.ownerID === actorId
          ? seat
          : await this.prisma.chatMember.findUnique({
              where: {
                conversationID_userID: {
                  conversationID: conversationId,
                  userID: group.ownerID,
                },
              },
              select: { leftAt: true },
            });
      if (!owner || owner.leftAt) throw new NotFoundException('群聊不存在');
      if (group.ownerID !== actorId && seat.role !== 'ADMIN')
        throw new ForbiddenException({
          message: '仅群主和管理员可审核',
          errorCode: 'CHAT_GROUP_MANAGER_ONLY',
        });
    }
    return { ...group, circle };
  }

  async list(actorId: string, conversationId: string, query: GroupReviewQuery) {
    const group = await this.context(actorId, conversationId);
    const limit = query.limit ?? 50;
    let cursor: { createdAt: Date } | null = null;
    if (query.cursor) {
      cursor = group.circleID
        ? await this.prisma.circleInvitation.findFirst({
            where: { id: query.cursor, circleID: group.circleID },
            select: { createdAt: true },
          })
        : await this.prisma.groupAdmission.findFirst({
            where: { id: query.cursor, conversationID: conversationId },
            select: { createdAt: true },
          });
    }
    if (query.cursor && !cursor)
      throw new BadRequestException({
        message: '分页游标已失效，请刷新',
        errorCode: 'CHAT_INVALID_PAYLOAD',
      });
    const keyword = query.keyword?.trim();
    const pattern = `%${(keyword ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const table = group.circleID
      ? Prisma.sql`"CircleInvitation"`
      : Prisma.sql`"GroupAdmission"`;
    const scope = group.circleID
      ? Prisma.sql`a."circleID" = ${group.circleID}`
      : Prisma.sql`a."conversationID" = ${conversationId}`;
    const source = group.circleID
      ? Prisma.sql`a."source"`
      : Prisma.sql`a."kind"`;
    const reason = group.circleID
      ? Prisma.sql`''::text`
      : Prisma.sql`a."reason"`;
    const status = group.circleID
      ? Prisma.sql`CASE WHEN a."status" IN ('APPROVED', 'ADMIN_APPROVED') THEN CASE WHEN membership."status" = 'ACTIVE' THEN 'JOINED' ELSE 'LEFT' END ELSE a."status"::text END`
      : Prisma.sql`CASE WHEN a."status" IN ('INVITED', 'PENDING') AND a."expiresAt" <= NOW() THEN 'EXPIRED' WHEN a."status" = 'JOINED' AND (membership."userID" IS NULL OR membership."leftAt" IS NOT NULL) THEN 'LEFT' ELSE a."status" END`;
    const memberJoin = group.circleID
      ? Prisma.sql`LEFT JOIN "CircleMember" membership ON membership."userID" = a."applicantID" AND membership."circleID" = a."circleID"`
      : Prisma.sql`LEFT JOIN "ChatMember" membership ON membership."userID" = a."applicantID" AND membership."conversationID" = a."conversationID"`;
    const rows = await this.prisma.$queryRaw<ReviewRow[]>(Prisma.sql`
      SELECT a."id", a."applicantID", a."inviterID", ${source} AS "source",
        CASE WHEN ban."userID" IS NOT NULL THEN 'BLACKLISTED' ELSE ${status} END AS "status",
        ${reason} AS "reason", a."createdAt", a."updatedAt",
        applicant."nickname" AS "applicantName", applicant."accountId" AS "applicantAccount", applicant."avatarUrl" AS "applicantAvatar",
        inviter."nickname" AS "inviterName", inviter."accountId" AS "inviterAccount", inviter."avatarUrl" AS "inviterAvatar"
      FROM ${table} a
      LEFT JOIN "User" applicant ON applicant."id" = a."applicantID"
      LEFT JOIN "User" inviter ON inviter."id" = a."inviterID"
      ${memberJoin}
      LEFT JOIN "ChatGroupJoinBan" ban ON ban."conversationID" = ${conversationId} AND ban."userID" = a."applicantID"
      WHERE ${scope}
        ${cursor ? Prisma.sql`AND (a."createdAt", a."id") < (${cursor.createdAt}, ${query.cursor})` : Prisma.empty}
        ${keyword ? Prisma.sql`AND (applicant."nickname" ILIKE ${pattern} OR applicant."accountId" ILIKE ${pattern})` : Prisma.empty}
      ORDER BY a."createdAt" DESC, a."id" DESC LIMIT ${limit + 1}
    `);
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      conversationId,
      source: row.source,
      status: row.status,
      reason: row.reason,
      applicant: {
        id: row.applicantID,
        nickname: row.applicantName ?? '',
        accountId: row.applicantAccount ?? '',
        avatarUrl: row.applicantAvatar,
      } satisfies ReviewPerson,
      inviter:
        row.inviterID && row.inviterID !== row.applicantID
          ? ({
              id: row.inviterID,
              nickname: row.inviterName ?? '',
              accountId: row.inviterAccount ?? '',
              avatarUrl: row.inviterAvatar,
            } satisfies ReviewPerson)
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    return {
      group: {
        id: group.id,
        name: group.circle?.name ?? group.name ?? '',
        circleId: group.circleID,
      },
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  async act(
    actorId: string,
    conversationId: string,
    ids: string[],
    action: GroupReviewAction,
  ) {
    const group = await this.context(actorId, conversationId);
    const requests = group.circleID
      ? await this.prisma.circleInvitation.findMany({
          where: { id: { in: ids }, circleID: group.circleID },
          select: { id: true },
        })
      : await this.prisma.groupAdmission.findMany({
          where: { id: { in: ids }, conversationID: conversationId },
          select: { id: true },
        });
    const scoped = new Set(requests.map((item) => item.id));
    const results: Array<{ id: string; ok: boolean; errorCode?: string }> = [];
    for (const id of ids) {
      if (!scoped.has(id)) {
        results.push({
          id,
          ok: false,
          errorCode: 'CHAT_GROUP_REQUEST_UNAVAILABLE',
        });
        continue;
      }
      try {
        if (group.circleID) {
          if (action === 'approve')
            await this.invitations.adminApprove(actorId, id);
          else
            await this.invitations.adminReject(
              actorId,
              id,
              action === 'blacklist',
            );
        } else await this.admissions.act(actorId, id, action);
        results.push({ id, ok: true });
      } catch (error) {
        const response =
          error instanceof HttpException ? error.getResponse() : null;
        const errorCode =
          response &&
          typeof response === 'object' &&
          'errorCode' in response &&
          typeof response.errorCode === 'string'
            ? response.errorCode
            : 'GROUP_REVIEW_FAILED';
        results.push({ id, ok: false, errorCode });
        if (!(error instanceof HttpException))
          this.logger.warn(
            `group review action failed (${error instanceof Error ? error.name : 'unknown'})`,
          );
      }
    }
    return { results };
  }
}
