import { businessMetrics } from 'src/metrics/business-metrics';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import type { GroupAdmission, Prisma } from 'src/generated/prisma';
import { NotificationService } from 'src/notification/notification.service';
import { ChatService } from './chat.service';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatSystemMessageService } from './chat-system-message.service';
import { lockUserRelationshipState } from 'src/utils/user-relationship-lock';
import { normalizeUserIdAlias } from 'src/user/user-id-alias';

const ACTIVE = ['INVITED', 'PENDING'];
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 200;
type Tx = Prisma.TransactionClient;
type Group = {
  id: string;
  type: string;
  circleID: string | null;
  ownerID: string | null;
  name: string | null;
  avatarUrl: string | null;
  memberCanInvite: boolean;
  qrJoinEnabled: boolean;
  cardJoinEnabled: boolean;
  joinApprovalRequired: boolean;
  clearedBeforeHeight: number;
};
function fail(message: string, code: string): never {
  throw new ForbiddenException({ message, errorCode: code });
}

@Injectable()
export class GroupAdmissionService {
  private readonly logger = new Logger(GroupAdmissionService.name);
  private delivering = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly broadcast: ChatBroadcastService,
    private readonly messages: ChatSystemMessageService,
    private readonly notifications: NotificationService,
  ) {}

  private async lock(tx: Tx, id: string): Promise<Group> {
    const rows = await tx.$queryRaw<
      Group[]
    >`SELECT "id", "type", "circleID", "ownerID", "name", "avatarUrl", "memberCanInvite", "qrJoinEnabled", "cardJoinEnabled", "joinApprovalRequired", "clearedBeforeHeight" FROM "ChatConversation" WHERE "id" = ${id} FOR UPDATE`;
    const g = rows[0];
    if (!g || g.type !== 'GROUP' || g.circleID || !g.ownerID)
      throw new NotFoundException({
        message: '群聊不存在或已解散',
        errorCode: 'CHAT_CONVERSATION_NOT_FOUND',
      });
    return g;
  }
  private async member(tx: Tx, id: string, user: string) {
    return tx.chatMember.findUnique({
      where: { conversationID_userID: { conversationID: id, userID: user } },
    });
  }
  private async manager(tx: Tx, g: Group, user: string) {
    const seat = await this.member(tx, g.id, user);
    return Boolean(
      seat && !seat.leftAt && (g.ownerID === user || seat.role === 'ADMIN'),
    );
  }
  private async requiresApproval(tx: Tx, g: Group, a: GroupAdmission) {
    if (a.kind === 'APPLICATION') return true;
    if (!g.joinApprovalRequired) return false;
    // Only a direct invitation from a current manager substitutes for approval.
    // Shared QR codes continue to follow the group's QR admission policy.
    return !(
      a.kind === 'INVITE' &&
      a.inviterID &&
      (await this.manager(tx, g, a.inviterID))
    );
  }
  private async assertInviter(tx: Tx, g: Group, inviter: string) {
    const seat = await this.member(tx, g.id, inviter);
    if (!seat || seat.leftAt)
      fail('邀请人已不在群里', 'CHAT_GROUP_INVITATION_INVALID');
    if (!g.memberCanInvite && !(await this.manager(tx, g, inviter)))
      fail('该群已关闭成员邀请', 'CHAT_GROUP_INVITE_DISABLED');
  }
  private async targets(tx: Tx, actor: string, users: string[]) {
    await lockUserRelationshipState(tx, [actor, ...users]);
    const [friends, settings, active, blocked] = await Promise.all([
      tx.friend.findMany({
        where: {
          state: 'ACCEPTED',
          OR: [
            { userID: actor, friendID: { in: users } },
            { friendID: actor, userID: { in: users } },
          ],
        },
        select: { userID: true, friendID: true },
      }),
      tx.userPrivacySetting.findMany({
        where: { userID: { in: users } },
        select: { userID: true, groupInvitePermission: true },
      }),
      tx.user.count({ where: { id: { in: users }, status: 'ACTIVE' } }),
      tx.block.findFirst({
        where: {
          OR: [
            { blockerID: actor, blockedID: { in: users } },
            { blockedID: actor, blockerID: { in: users } },
          ],
        },
      }),
    ]);
    const ids = new Set(
      friends.map((f) => (f.userID === actor ? f.friendID : f.userID)),
    );
    if (blocked || users.some((id) => !ids.has(id)))
      fail('只能邀请未拉黑的好友进群', 'CHAT_GROUP_FRIENDS_ONLY');
    if (settings.some((s) => s.groupInvitePermission === 'NONE'))
      fail('对方不允许群邀请', 'GROUP_INVITE_NOT_ALLOWED');
    if (active !== users.length)
      throw new NotFoundException({
        message: '部分用户不存在或不可用',
        errorCode: 'CHAT_PEER_NOT_FOUND',
      });
  }
  private async event(
    tx: Tx,
    a: GroupAdmission,
    actor: string,
    event: string,
    recipients: string[],
  ) {
    for (const recipient of new Set(recipients)) {
      await tx.groupAdmissionDelivery.upsert({
        where: {
          admissionID_recipientID_event: {
            admissionID: a.id,
            recipientID: recipient,
            event,
          },
        },
        create: {
          admissionID: a.id,
          recipientID: recipient,
          actorID: actor,
          event,
        },
        update: {},
      });
    }
  }
  private async reviewers(tx: Tx, g: Group): Promise<string[]> {
    const seats = await tx.chatMember.findMany({
      where: {
        conversationID: g.id,
        leftAt: null,
        OR: [{ userID: g.ownerID! }, { role: 'ADMIN' }],
      },
      select: { userID: true },
    });
    return seats.map((s) => s.userID);
  }
  private async current(tx: Tx, group: string, applicant: string) {
    await tx.groupAdmission.updateMany({
      where: {
        conversationID: group,
        applicantID: applicant,
        status: { in: ACTIVE },
        expiresAt: { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    return tx.groupAdmission.findFirst({
      where: {
        conversationID: group,
        applicantID: applicant,
        status: { in: ACTIVE },
      },
    });
  }
  async invite(actor: string, group: string, rawUsers: string[]) {
    const users = [...new Set(rawUsers.map(normalizeUserIdAlias))].filter(
      (u) => u !== actor,
    );
    if (!users.length || users.length > 100)
      throw new BadRequestException('请选择 1 至 100 位好友');
    await this.prisma.$transaction(async (tx) => {
      const g = await this.lock(tx, group);
      await this.assertInviter(tx, g, actor);
      await this.targets(tx, actor, users);
      for (const user of users) {
        const seat = await this.member(tx, group, user);
        if (seat && !seat.leftAt) continue;
        const existing = await this.current(tx, group, user);
        if (existing) continue;
        const a = await tx.groupAdmission.create({
          data: {
            conversationID: group,
            applicantID: user,
            inviterID: actor,
            kind: 'INVITE',
            status: 'INVITED',
            expiresAt: new Date(Date.now() + TTL),
          },
        });
        await this.event(tx, a, actor, 'INVITED', [user]);
      }
    });
    await this.flush();
    return this.chat.getGroupConversationForMember(actor, group);
  }
  async preview(user: string, id: string) {
    const g =
      (await this.prisma.chatConversation.findUnique({ where: { id } })) ??
      (await this.prisma.chatConversation.findUnique({
        where: { circleID: id },
      }));
    if (g?.type === 'GROUP' && g.circleID) {
      const [circle, membership, count] = await Promise.all([
        this.prisma.circle.findUnique({
          where: { id: g.circleID },
          select: { name: true, avatarUrl: true },
        }),
        this.prisma.circleMember.findUnique({
          where: { userID_circleID: { userID: user, circleID: g.circleID } },
        }),
        this.prisma.circleMember.count({
          where: { circleID: g.circleID, status: 'ACTIVE' },
        }),
      ]);
      if (!circle) throw new NotFoundException('圈子不存在');
      return {
        id: g.id,
        circleId: g.circleID,
        name: circle.name,
        avatarUrl: circle.avatarUrl,
        memberCount: count,
        isMember: membership?.status === 'ACTIVE',
        canManage: false,
        cardJoinEnabled: false,
        joinApprovalRequired: true,
        admission: null,
      };
    }
    if (!g || g.type !== 'GROUP' || g.circleID || !g.ownerID)
      throw new NotFoundException({
        message: '群聊不存在或已解散',
        errorCode: 'CHAT_CONVERSATION_NOT_FOUND',
      });
    const [seat, count, admission] = await Promise.all([
      this.prisma.chatMember.findUnique({
        where: { conversationID_userID: { conversationID: id, userID: user } },
      }),
      this.prisma.chatMember.count({
        where: { conversationID: id, leftAt: null },
      }),
      this.prisma.groupAdmission.findFirst({
        where: { conversationID: id, applicantID: user },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      id,
      name: g.name ?? '',
      avatarUrl: g.avatarUrl,
      memberCount: count,
      isMember: Boolean(seat && !seat.leftAt),
      canManage: Boolean(
        seat && !seat.leftAt && (g.ownerID === user || seat.role === 'ADMIN'),
      ),
      cardJoinEnabled: g.cardJoinEnabled,
      joinApprovalRequired: g.joinApprovalRequired,
      admission: admission
        ? {
            ...this.dto(admission),
            ...(admission.status === 'JOINED' && (!seat || seat.leftAt)
              ? {
                  status: 'LEFT',
                  updatedAt:
                    seat?.leftAt?.toISOString() ??
                    admission.updatedAt.toISOString(),
                }
              : {}),
            requiresApproval: await this.requiresApproval(
              this.prisma,
              g,
              admission,
            ),
          }
        : null,
    };
  }
  async apply(user: string, id: string, reason: string) {
    const a = await this.prisma.$transaction(async (tx) => {
      const g = await this.lock(tx, id);
      if (!g.cardJoinEnabled)
        fail('该群暂不接受名片申请', 'CHAT_GROUP_APPLICATION_DISABLED');
      const seat = await this.member(tx, id, user);
      if (seat && !seat.leftAt) return null;
      const existing = await this.current(tx, id, user);
      if (existing) return existing;
      const a = await tx.groupAdmission.create({
        data: {
          conversationID: id,
          applicantID: user,
          kind: 'APPLICATION',
          status: 'PENDING',
          reason,
          acceptedAt: new Date(),
          expiresAt: new Date(Date.now() + TTL),
        },
      });
      await this.event(tx, a, user, 'PENDING', await this.reviewers(tx, g));
      return a;
    });
    await this.flush();
    return a
      ? this.detail(user, a.id)
      : { status: 'JOINED', conversationId: id };
  }
  private async validateSource(tx: Tx, g: Group, a: GroupAdmission) {
    if (a.expiresAt <= new Date())
      fail('邀请或申请已过期', 'CHAT_GROUP_INVITATION_INVALID');
    if (a.kind === 'APPLICATION') {
      if (!g.cardJoinEnabled)
        fail('该群已关闭名片申请', 'CHAT_GROUP_APPLICATION_DISABLED');
      return;
    }
    if (!a.inviterID) fail('邀请已失效', 'CHAT_GROUP_INVITATION_INVALID');
    await this.assertInviter(tx, g, a.inviterID);
    if (a.kind === 'INVITE')
      await this.targets(tx, a.inviterID, [a.applicantID]);
    if (a.kind === 'QR') {
      if (!g.qrJoinEnabled)
        fail('该群已关闭二维码入群', 'CHAT_GROUP_QR_JOIN_DISABLED');
      const token = await tx.qrToken.findUnique({
        where: { token: a.qrToken! },
      });
      if (
        !token ||
        token.type !== 'GROUP' ||
        token.targetID !== g.id ||
        token.issuerID !== a.inviterID ||
        token.revokedAt ||
        (token.expiresAt && token.expiresAt <= new Date())
      )
        fail('二维码邀请已失效', 'CHAT_GROUP_INVITATION_INVALID');
    }
  }
  private async join(tx: Tx, g: Group, a: GroupAdmission, actor: string) {
    if (!a.acceptedAt) fail('尚未接受邀请', 'CHAT_GROUP_ACCEPT_REQUIRED');
    const active = await tx.user.findUnique({
      where: { id: a.applicantID },
      select: { status: true },
    });
    if (active?.status !== 'ACTIVE') fail('用户不可用', 'CHAT_PEER_NOT_FOUND');
    const seat = await this.member(tx, g.id, a.applicantID);
    if (!seat || seat.leftAt) {
      const count = await tx.chatMember.count({
        where: { conversationID: g.id, leftAt: null },
      });
      if (count >= MAX_MEMBERS)
        throw new ConflictException({
          message: '群聊人数已达上限',
          errorCode: 'CHAT_GROUP_FULL',
        });
      const top = await tx.chatMessage.aggregate({
        where: { conversationID: g.id },
        _max: { height: true },
      });
      await tx.chatMember.upsert({
        where: {
          conversationID_userID: {
            conversationID: g.id,
            userID: a.applicantID,
          },
        },
        create: {
          conversationID: g.id,
          userID: a.applicantID,
          clearedBeforeHeight: Math.max(
            g.clearedBeforeHeight,
            top._max.height ?? 0,
          ),
        },
        update: {
          leftAt: null,
          joinedAt: new Date(),
          role: 'MEMBER',
          hiddenAt: null,
          clearedBeforeHeight: Math.max(
            g.clearedBeforeHeight,
            top._max.height ?? 0,
          ),
        },
      });
    }
    const joined = await tx.groupAdmission.update({
      where: { id: a.id },
      data: { status: 'JOINED', decidedByID: actor },
    });
    await this.event(tx, joined, actor, 'JOINED', [a.applicantID]);
    return joined;
  }
  async acceptQr(user: string, token: string) {
    const row = await this.prisma.qrToken.findUnique({ where: { token } });
    if (!row || row.type !== 'GROUP')
      fail('二维码邀请无效', 'CHAT_GROUP_INVITATION_INVALID');
    const a = await this.prisma.$transaction(async (tx) => {
      const g = await this.lock(tx, row.targetID);
      const seat = await this.member(tx, g.id, user);
      if (seat && !seat.leftAt) return null;
      const existing = await this.current(tx, g.id, user);
      if (existing?.status === 'PENDING') return existing;
      // A direct invitation must still be accepted on its own detail page.
      if (existing) fail('请先处理已有的群邀请', 'CHAT_GROUP_ACCEPT_REQUIRED');
      let a = await tx.groupAdmission.create({
        data: {
          conversationID: g.id,
          applicantID: user,
          inviterID: row.issuerID,
          qrToken: token,
          kind: 'QR',
          status: 'PENDING',
          acceptedAt: new Date(),
          expiresAt: row.expiresAt ?? new Date(Date.now() + TTL),
        },
      });
      await this.validateSource(tx, g, a);
      if (!g.joinApprovalRequired) a = await this.join(tx, g, a, user);
      else
        await this.event(tx, a, user, 'PENDING', await this.reviewers(tx, g));
      return a;
    });
    await this.flush();
    return {
      type: 'GROUP' as const,
      status:
        a?.status === 'PENDING' ? ('PENDING' as const) : ('JOINED' as const),
      ...(a?.status === 'PENDING'
        ? { admissionId: a.id }
        : { conversationId: row.targetID }),
    };
  }
  async act(
    user: string,
    id: string,
    action: 'accept' | 'decline' | 'approve' | 'reject',
  ) {
    const before = await this.prisma.groupAdmission.findUnique({
      where: { id },
    });
    if (!before) throw new NotFoundException('邀请或申请不存在');
    await this.prisma.$transaction(async (tx) => {
      const g = await this.lock(tx, before.conversationID);
      const a = await tx.groupAdmission.findUniqueOrThrow({ where: { id } });
      const selfAction = action === 'accept' || action === 'decline';
      if (
        selfAction ? a.applicantID !== user : !(await this.manager(tx, g, user))
      )
        fail('没有操作权限', 'CHAT_NOT_MEMBER');
      if (
        a.status === 'JOINED' ||
        (a.status === 'DECLINED' && action === 'decline') ||
        (a.status === 'REJECTED' && action === 'reject')
      )
        return;
      if (selfAction && a.kind !== 'INVITE')
        throw new ConflictException('当前记录不是待接受邀请');
      if (action === 'decline') {
        if (a.status !== 'INVITED') throw new ConflictException('邀请已处理');
        const declined = await tx.groupAdmission.update({
          where: { id },
          data: { status: 'DECLINED' },
        });
        await this.event(
          tx,
          declined,
          user,
          'DECLINED',
          a.inviterID ? [a.inviterID] : [],
        );
        return;
      }
      if (action !== 'reject') await this.validateSource(tx, g, a);
      if (action === 'accept') {
        if (a.status === 'PENDING') return;
        if (a.status !== 'INVITED') throw new ConflictException('邀请已处理');
        const accepted = await tx.groupAdmission.update({
          where: { id },
          data: { acceptedAt: new Date(), status: 'PENDING' },
        });
        if (!(await this.requiresApproval(tx, g, accepted)))
          await this.join(tx, g, accepted, a.inviterID ?? user);
        else
          await this.event(
            tx,
            accepted,
            user,
            'PENDING',
            await this.reviewers(tx, g),
          );
      } else {
        if (a.status !== 'PENDING' || !a.acceptedAt)
          fail('对方尚未接受或申请已处理', 'CHAT_GROUP_ACCEPT_REQUIRED');
        if (action === 'approve') await this.join(tx, g, a, user);
        else {
          const rejected = await tx.groupAdmission.update({
            where: { id },
            data: { status: 'REJECTED', decidedByID: user },
          });
          await this.event(tx, rejected, user, 'REJECTED', [a.applicantID]);
        }
      }
    });
    if (action === 'approve' || action === 'reject')
      await this.finishReviewNotices(id);
    await this.flush();
    return this.detail(user, id);
  }
  private async finishReviewNotices(id: string) {
    const notices = await this.prisma.$transaction(async (tx) => {
      const jobs = await tx.groupAdmissionDelivery.findMany({
        where: { admissionID: id, event: 'PENDING' },
        select: { id: true },
      });
      const ids = jobs.map((job) => job.id);
      await tx.groupAdmissionDelivery.updateMany({
        where: { id: { in: ids }, deliveredAt: null },
        data: { deliveredAt: new Date() },
      });
      await tx.notificationPushOutbox.updateMany({
        where: {
          notificationID: { in: ids },
          status: { in: ['PENDING', 'FAILED'] },
        },
        data: {
          status: 'TERMINAL',
          processedAt: new Date(),
          lastError: 'group-review-finished',
        },
      });
      return tx.notification.findMany({
        where: { id: { in: ids }, read: false, deleted: false },
        select: { id: true, toUserID: true },
      });
    });
    for (const notice of notices)
      if (notice.toUserID)
        await this.notifications.markNotificationRead(
          notice.toUserID,
          notice.id,
        );
  }
  private dto(a: GroupAdmission) {
    return {
      id: a.id,
      conversationId: a.conversationID,
      applicantId: a.applicantID,
      inviterId: a.inviterID,
      kind: a.kind,
      status:
        ACTIVE.includes(a.status) && a.expiresAt <= new Date()
          ? 'EXPIRED'
          : a.status,
      reason: a.reason,
      expiresAt: a.expiresAt.toISOString(),
      acceptedAt: a.acceptedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }
  async detail(user: string, id: string) {
    const a = await this.prisma.groupAdmission.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('邀请或申请不存在');
    const group = await this.preview(user, a.conversationID).catch(
      (error: unknown) => {
        if (!(error instanceof NotFoundException)) throw error;
        return {
          id: a.conversationID,
          name: '',
          avatarUrl: null,
          memberCount: 0,
          isMember: false,
          canManage: false,
          cardJoinEnabled: false,
          joinApprovalRequired: true,
          admission: null,
          unavailable: true,
        };
      },
    );
    if (a.applicantID !== user && a.inviterID !== user && !group.canManage)
      fail('没有查看权限', 'CHAT_NOT_MEMBER');
    const people = await this.prisma.user.findMany({
      where: {
        id: { in: [a.applicantID, ...(a.inviterID ? [a.inviterID] : [])] },
      },
      select: { id: true, nickname: true },
    });
    const currentGroup = await this.prisma.chatConversation.findUnique({
      where: { id: a.conversationID },
    });
    const applicantSeat = await this.member(
      this.prisma,
      a.conversationID,
      a.applicantID,
    );
    return {
      ...this.dto(a),
      ...(a.status === 'JOINED' && (!applicantSeat || applicantSeat.leftAt)
        ? {
            status: 'LEFT',
            updatedAt:
              applicantSeat?.leftAt?.toISOString() ?? a.updatedAt.toISOString(),
          }
        : {}),
      requiresApproval: currentGroup
        ? await this.requiresApproval(this.prisma, currentGroup, a)
        : true,
      group,
      applicantName: people.find((p) => p.id === a.applicantID)?.nickname ?? '',
      inviterName: people.find((p) => p.id === a.inviterID)?.nickname ?? '',
      isApplicant: a.applicantID === user,
    };
  }
  async unread(user: string) {
    return {
      count: await this.prisma.notification.count({
        where: {
          toUserID: user,
          type: { in: ['GROUP_ADMISSION', 'CIRCLE_INVITATION_RECEIVED'] },
          read: false,
          deleted: false,
        },
      }),
    };
  }
  async seen(user: string, id: string) {
    await this.detail(user, id);
    const rows = await this.prisma.notification.findMany({
      where: {
        toUserID: user,
        fromGroupAdmissionID: id,
        read: false,
        deleted: false,
      },
      select: { id: true },
    });
    for (const row of rows)
      await this.notifications.markNotificationRead(user, row.id);
    return this.unread(user);
  }
  async list(user: string, cursor?: string, groupId?: string) {
    const manageable = await this.prisma.chatConversation.findMany({
      where: {
        type: 'GROUP',
        circleID: null,
        members: { some: { userID: user, leftAt: null } },
        OR: [
          { ownerID: user },
          { members: { some: { userID: user, leftAt: null, role: 'ADMIN' } } },
        ],
      },
      select: { id: true },
    });
    const rows = await this.prisma.groupAdmission.findMany({
      where: {
        ...(groupId ? { conversationID: groupId } : {}),
        OR: [
          { applicantID: user },
          { inviterID: user },
          {
            conversationID: { in: manageable.map((g) => g.id) },
            status: 'PENDING',
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 51,
    });
    const page = rows.slice(0, 50);
    const groupIDs = [...new Set(page.map((a) => a.conversationID))];
    const userIDs = [
      ...new Set(
        page.flatMap((a) => [
          a.applicantID,
          ...(a.inviterID ? [a.inviterID] : []),
        ]),
      ),
    ];
    const [groups, people, viewerSeats, counts, unreadCounts] =
      await Promise.all([
        this.prisma.chatConversation.findMany({
          where: { id: { in: groupIDs } },
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            ownerID: true,
            cardJoinEnabled: true,
            joinApprovalRequired: true,
          },
        }),
        this.prisma.user.findMany({
          where: { id: { in: userIDs } },
          select: { id: true, nickname: true },
        }),
        this.prisma.chatMember.findMany({
          where: {
            conversationID: { in: groupIDs },
            userID: { in: [...userIDs, user] },
          },
          select: {
            conversationID: true,
            userID: true,
            role: true,
            leftAt: true,
          },
        }),
        this.prisma.chatMember.groupBy({
          by: ['conversationID'],
          where: { conversationID: { in: groupIDs }, leftAt: null },
          _count: { _all: true },
        }),
        this.prisma.notification.groupBy({
          by: ['fromGroupAdmissionID'],
          where: {
            toUserID: user,
            type: 'GROUP_ADMISSION',
            read: false,
            deleted: false,
            fromGroupAdmissionID: { in: page.map((a) => a.id) },
          },
          _count: { _all: true },
        }),
      ]);
    const unreadByID = new Map(
      unreadCounts.map((row) => [row.fromGroupAdmissionID, row._count._all]),
    );
    const groupsByID = new Map(groups.map((g) => [g.id, g]));
    const namesByID = new Map(people.map((p) => [p.id, p.nickname]));
    const seatsByID = new Map(
      viewerSeats
        .filter((seat) => seat.userID === user && !seat.leftAt)
        .map((seat) => [seat.conversationID, seat]),
    );
    const applicantSeatsByID = new Map(
      viewerSeats.map((seat) => [
        `${seat.conversationID}:${seat.userID}`,
        seat,
      ]),
    );
    const countsByID = new Map(
      counts.map((count) => [count.conversationID, count._count._all]),
    );
    const items = page.flatMap((a) => {
      const g = groupsByID.get(a.conversationID);
      const seat = seatsByID.get(a.conversationID);
      const canManage = Boolean(
        g?.ownerID && seat && (g.ownerID === user || seat.role === 'ADMIN'),
      );
      if (a.applicantID !== user && a.inviterID !== user && !canManage)
        return [];
      return [
        {
          ...this.dto(a),
          ...(a.status === 'JOINED' &&
          (!applicantSeatsByID.get(`${a.conversationID}:${a.applicantID}`) ||
            applicantSeatsByID.get(`${a.conversationID}:${a.applicantID}`)
              ?.leftAt)
            ? {
                status: 'LEFT',
                updatedAt:
                  applicantSeatsByID
                    .get(`${a.conversationID}:${a.applicantID}`)
                    ?.leftAt?.toISOString() ?? a.updatedAt.toISOString(),
              }
            : {}),
          unreadCount: unreadByID.get(a.id) ?? 0,
          applicantName: namesByID.get(a.applicantID) ?? '',
          inviterName: a.inviterID ? (namesByID.get(a.inviterID) ?? '') : '',
          isApplicant: a.applicantID === user,
          group: {
            id: a.conversationID,
            name: g?.name ?? '',
            avatarUrl: g?.avatarUrl ?? null,
            memberCount: countsByID.get(a.conversationID) ?? 0,
            isMember: Boolean(seat && g?.ownerID),
            canManage,
            cardJoinEnabled: g?.cardJoinEnabled ?? false,
            joinApprovalRequired: g?.joinApprovalRequired ?? true,
            admission: null,
            unavailable: !g?.ownerID,
          },
        },
      ];
    });
    return { items, nextCursor: rows.length > 50 ? page[49].id : null };
  }
  @Interval(10_000)
  async flush() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const jobs = await this.prisma.groupAdmissionDelivery.findMany({
        where: {
          deliveredAt: null,
          attempts: { lt: 8 },
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        include: { admission: true },
      });
      for (const job of jobs) {
        try {
          const a = job.admission;
          // Approval is already the manager's acknowledgement. Do not replay
          // obsolete review prompts or fan joined notifications to managers.
          if (
            (job.event === 'PENDING' && a.status !== 'PENDING') ||
            (job.event === 'JOINED' && job.recipientID !== a.applicantID)
          ) {
            await this.prisma.groupAdmissionDelivery.update({
              where: { id: job.id },
              data: { deliveredAt: new Date() },
            });
            continue;
          }
          if (job.event === 'JOINED') {
            const seat = await this.member(
              this.prisma,
              a.conversationID,
              a.applicantID,
            );
            if (!seat || seat.leftAt || seat.joinedAt > a.updatedAt) {
              await this.prisma.groupAdmissionDelivery.update({
                where: { id: job.id },
                data: { deliveredAt: new Date() },
              });
              continue;
            }
          }
          const group = await this.prisma.chatConversation.findUnique({
            where: { id: a.conversationID },
          });
          const ownerSeat = group?.ownerID
            ? await this.member(this.prisma, a.conversationID, group.ownerID)
            : null;
          if (!group || !ownerSeat || ownerSeat.leftAt) {
            await this.prisma.groupAdmissionDelivery.update({
              where: { id: job.id },
              data: { deliveredAt: new Date() },
            });
            continue;
          }
          const name = group.name ?? '群聊';
          const copy: Record<string, string> = {
            INVITED: `邀请你加入「${name}」`,
            PENDING: `申请加入「${name}」，等待审核`,
            JOINED: `已加入「${name}」`,
            REJECTED: `加入「${name}」的申请未通过`,
            DECLINED: `已拒绝加入「${name}」的邀请`,
          };
          await this.notifications.deliverGroupAdmissionNotification({
            id: job.id,
            admissionId: a.id,
            toUserID: job.recipientID,
            fromUserID: job.actorID,
            content: copy[job.event] ?? name,
          });

          if (job.event === 'JOINED') {
            const seat = await this.prisma.chatMember.findUnique({
              where: {
                conversationID_userID: {
                  conversationID: a.conversationID,
                  userID: a.applicantID,
                },
              },
            });
            if (seat && !seat.leftAt) {
              await this.broadcast.joinUserToConversation(
                a.applicantID,
                a.conversationID,
              );
              this.broadcast.emitConversationChange(a.applicantID, {
                kind: 'joined',
                conversationId: a.conversationID,
                userId: a.applicantID,
              });
            }
          }
          if (job.event === 'INVITED' && a.inviterID) {
            const direct = await this.chat.getOrCreateDirectConversation(
              a.inviterID,
              a.applicantID,
            );
            await this.messages.insertServerMessage(direct.id, {
              senderID: a.inviterID,
              type: 'group-invitation',
              content: {
                admissionId: a.id,
                groupName: name,
                avatarUrl: group?.avatarUrl ?? null,
              },
              clientMessageId: `group_invitation_${a.id}`,
              rebroadcastOnReplay: true,
            });
          }
          await this.prisma.groupAdmissionDelivery.update({
            where: { id: job.id },
            data: { deliveredAt: new Date() },
          });
        } catch {
          const terminal = job.attempts + 1 >= 8;
          if (terminal)
            businessMetrics.recordEvent(
              'group_admission_delivery_exhausted',
              'failure',
            );
          this.logger.warn({
            event: 'group_admission_delivery_failed',
            terminal,
            deliveryId: job.id,
            attempt: job.attempts + 1,
            retryScheduled: !terminal,
          });
          await this.prisma.groupAdmissionDelivery.update({
            where: { id: job.id },
            data: {
              attempts: { increment: 1 },
              nextAttemptAt: new Date(
                Date.now() +
                  Math.min(300_000, 10_000 * 2 ** Math.min(job.attempts, 5)),
              ),
            },
          });
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
