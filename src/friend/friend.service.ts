import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendErrorCode } from 'src/common/app-error-codes';
import {
  FriendReportStatus,
  FriendState,
  NotificationType,
} from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationService } from 'src/notification/notification.service';
import { OpenimService } from 'src/openim/openim.service';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import {
  FriendProfileDto,
  FriendActivityDto,
  FriendActivityUnreadCountDto,
  FriendRequestDto,
  FriendSettingsDto,
  FriendStatusDto,
  ReportFriendDto,
} from './dto/friend.dto';

// Members (paid) get 5 000, regular users get 1 000.
const FRIEND_LIMIT_USER = 1_000;
const FRIEND_LIMIT_MEMBER = 5_000;
const FRIEND_ACCEPTED_REPLY_MESSAGE = '我通过了你的好友请求，现在开始聊天吧';

// Cap on how many organizational tags a single user can create.
const MAX_FRIEND_TAGS_PER_USER = 50;

// Minimal user shape returned inside friend/request payloads
const MINI_USER_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
} as const;

// Full profile shape returned in the friend list
const FRIEND_PROFILE_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  avatarFrame: true,
  gender: true,
  lastOnline: true,
} as const;

const FRIEND_ACTIVITY_TYPE = {
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  REQUEST_SENT: 'REQUEST_SENT',
  REQUEST_ACCEPTED_BY_OTHER: 'REQUEST_ACCEPTED_BY_OTHER',
  REQUEST_REJECTED_BY_OTHER: 'REQUEST_REJECTED_BY_OTHER',
  REQUEST_ACCEPTED_BY_ME: 'REQUEST_ACCEPTED_BY_ME',
  REQUEST_REJECTED_BY_ME: 'REQUEST_REJECTED_BY_ME',
  REQUEST_WITHDRAWN_BY_OTHER: 'REQUEST_WITHDRAWN_BY_OTHER',
} as const;

type FriendActivityType =
  (typeof FRIEND_ACTIVITY_TYPE)[keyof typeof FRIEND_ACTIVITY_TYPE];

const FRIEND_ACTIVITY_INCLUDE = {
  counterparty: { select: MINI_USER_SELECT },
  request: {
    select: {
      id: true,
      state: true,
      message: true,
    },
  },
} as const;

@Injectable()
export class FriendService {
  private readonly logger = new Logger(FriendService.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly notificationService: NotificationService,
    private readonly openimService: OpenimService,
    private readonly privacySettings: PrivacySettingsService,
  ) {}

  // ─── Send request ────────────────────────────────────────────────────────────

  async sendRequest(
    senderId: string,
    targetId: string,
    message?: string,
    remark?: string,
    tagIds?: string[],
  ): Promise<void> {
    if (senderId === targetId) {
      throw new BadRequestException({
        message: 'You cannot add yourself as a friend',
        errorCode: FriendErrorCode.SelfAdd,
      });
    }

    // Make sure the target user exists and is active
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, status: true, role: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: FriendErrorCode.UserNotFound,
      });
    }

    // Block check in both directions
    const block = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerID: senderId, blockedID: targetId },
          { blockerID: targetId, blockedID: senderId },
        ],
      },
    });
    if (block) {
      throw new ForbiddenException({
        message: 'Cannot send a friend request to this user',
        errorCode: FriendErrorCode.BlockedCannotRequest,
      });
    }

    const canReceiveStrangerMessage =
      await this.privacySettings.canReceiveStrangerMessage(targetId, false);
    if (!canReceiveStrangerMessage) {
      throw new ForbiddenException({
        message: 'This user does not allow stranger messages',
        errorCode: FriendErrorCode.StrangerMsgNotAllowed,
      });
    }

    // Enforce friend limit for the sender
    await this.assertBelowFriendLimit(senderId);

    const normalizedTagIds = Array.from(new Set(tagIds ?? []));
    if (normalizedTagIds.length > 0) {
      const ownedTags = await this.prisma.friendTag.findMany({
        where: {
          ownerID: senderId,
          id: { in: normalizedTagIds },
        },
        select: { id: true },
      });

      if (ownedTags.length !== normalizedTagIds.length) {
        throw new NotFoundException({
          message: 'Tag not found',
          errorCode: FriendErrorCode.TagNotFound,
        });
      }
    }

    const pendingRemarkBySender = remark ?? null;
    const requestData = {
      userID: senderId,
      friendID: targetId,
      state: FriendState.PENDING,
      message: message ?? null,
      pendingRemarkBySender,
    } as any;

    let request: { id: string };
    try {
      request = await this.prisma.$transaction(async (tx: any) => {
        // `Friend` has no DB-level unique constraint, so a check-then-insert
        // would race under concurrent requests for the same pair (e.g. a
        // double-tap). Serialize per user-pair with a transaction-scoped
        // advisory lock — released automatically on commit/rollback.
        const pairKey = `friend:${[senderId, targetId]
          .sort((a, b) => a.localeCompare(b))
          .join(':')}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

        const existing = await tx.friend.findFirst({
          where: {
            OR: [
              { userID: senderId, friendID: targetId },
              { userID: targetId, friendID: senderId },
            ],
            state: { in: [FriendState.ACCEPTED, FriendState.PENDING] },
          },
        });
        if (existing) {
          if (existing.state === FriendState.ACCEPTED) {
            throw new ConflictException({
              message: 'Already friends',
              errorCode: FriendErrorCode.AlreadyFriends,
            });
          }
          throw new ConflictException({
            message: 'Friend request already pending',
            errorCode: FriendErrorCode.RequestAlreadyPending,
          });
        }

        const nextRequestRecord = await tx.friend.create({
          data: requestData,
        });

        await this.syncPendingFriendTagLinks(
          tx,
          senderId,
          nextRequestRecord.id,
          normalizedTagIds,
        );

        await this.createFriendActivities(tx, [
          {
            requestId: nextRequestRecord.id,
            viewerId: senderId,
            actorId: senderId,
            counterpartyId: targetId,
            type: FRIEND_ACTIVITY_TYPE.REQUEST_SENT,
            messageSnapshot: nextRequestRecord.message ?? null,
          },
          {
            requestId: nextRequestRecord.id,
            viewerId: targetId,
            actorId: senderId,
            counterpartyId: senderId,
            type: FRIEND_ACTIVITY_TYPE.REQUEST_RECEIVED,
            messageSnapshot: nextRequestRecord.message ?? null,
          },
        ]);

        return nextRequestRecord;
      });
    } catch (error) {
      if (this.isPrismaUniqueConstraintError(error)) {
        await this.throwActiveFriendConflict(senderId, targetId);
      }

      throw error;
    }

    this.logger.log(`Friend request sent: ${senderId} → ${targetId}`);
    await this.broadcastFriendUnreadUpdates([senderId, targetId]);
    await this.createAndBroadcastFriendRequestNotification({
      type: NotificationType.FRIEND_REQUEST_RECEIVED,
      toUserId: targetId,
      fromUserId: senderId,
      content: message ?? '',
    });
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'friend_request_sent',
      actorId: senderId,
      targetId,
      result: 'success',
      entityType: 'friend_request',
      entityId: request.id,
    });
  }

  // ─── Cancel request (sender withdraws) ───────────────────────────────────────

  async cancelRequest(senderId: string, requestId: string): Promise<void> {
    const record = await this.prisma.friend.findUnique({
      where: { id: requestId },
    });
    if (
      !record ||
      record.userID !== senderId ||
      record.state !== FriendState.PENDING
    ) {
      throw new NotFoundException({
        message: 'Pending request not found',
        errorCode: FriendErrorCode.PendingRequestNotFound,
      });
    }
    await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.friend.update({
        where: { id: requestId },
        data: { state: FriendState.WITHDRAWN },
      });

      // A withdrawn request can never be accepted, so its staged tag links
      // are dead weight — drop them instead of leaving orphan rows.
      await tx.pendingFriendTagOnRequest.deleteMany({
        where: { requestID: requestId },
      });

      await this.createFriendActivities(tx, [
        {
          requestId: updated.id,
          viewerId: updated.friendID,
          actorId: senderId,
          counterpartyId: senderId,
          type: FRIEND_ACTIVITY_TYPE.REQUEST_WITHDRAWN_BY_OTHER,
          messageSnapshot: updated.message ?? null,
        },
      ]);
    });
    await this.broadcastFriendUnreadUpdates([senderId, record.friendID]);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'friend_request_withdrawn',
      actorId: senderId,
      targetId: record.friendID,
      result: 'success',
      entityType: 'friend_request',
      entityId: requestId,
    });
  }

  // ─── Accept / Reject (recipient decides) ────────────────────────────────────

  async handleRequest(
    recipientId: string,
    requestId: string,
    decision: 'ACCEPTED' | 'REJECTED',
  ): Promise<void> {
    const record: any = await this.prisma.friend.findUnique({
      where: { id: requestId },
    });
    if (
      !record ||
      record.friendID !== recipientId ||
      record.state !== FriendState.PENDING
    ) {
      throw new NotFoundException({
        message: 'Pending request not found',
        errorCode: FriendErrorCode.PendingRequestNotFound,
      });
    }

    if (decision === FriendState.ACCEPTED) {
      // The sender (record.userID) may have been banned/deleted between
      // sending the request and the recipient acting on it. Accepting would
      // otherwise produce a live friendship with an inactive account.
      const sender = await this.prisma.user.findUnique({
        where: { id: record.userID },
        select: {
          status: true,
          nickname: true,
          accountId: true,
          avatarUrl: true,
        },
      });
      if (!sender || sender.status !== 'ACTIVE') {
        throw new NotFoundException({
          message: 'The requester is no longer available',
          errorCode: FriendErrorCode.RequesterUnavailable,
        });
      }

      // Enforce friend limit for the recipient too
      await this.assertBelowFriendLimit(recipientId);
    }

    const nextRequest = await this.prisma.$transaction(async (tx: any) => {
      const data: any = { state: decision };

      if (
        decision === FriendState.ACCEPTED &&
        record.pendingRemarkBySender !== null &&
        record.pendingRemarkBySender !== undefined
      ) {
        // The sender is stored in userID, so the sender-owned active remark slot is remarkA.
        data.remarkA = record.pendingRemarkBySender;
      }

      const nextRequest = await tx.friend.update({
        where: { id: requestId },
        data,
      });

      if (decision === FriendState.ACCEPTED) {
        await this.promotePendingFriendTags(tx, nextRequest);
      }

      // Once a request leaves PENDING the staged tag links have served their
      // purpose (promoted on accept, irrelevant on reject) — clear them so
      // they don't accumulate as orphan rows.
      await tx.pendingFriendTagOnRequest.deleteMany({
        where: { requestID: requestId },
      });

      await this.createFriendActivities(
        tx,
        decision === FriendState.ACCEPTED
          ? [
              {
                requestId: nextRequest.id,
                viewerId: recipientId,
                actorId: recipientId,
                counterpartyId: nextRequest.userID,
                type: FRIEND_ACTIVITY_TYPE.REQUEST_ACCEPTED_BY_ME,
                messageSnapshot: nextRequest.message ?? null,
              },
              {
                requestId: nextRequest.id,
                viewerId: nextRequest.userID,
                actorId: recipientId,
                counterpartyId: recipientId,
                type: FRIEND_ACTIVITY_TYPE.REQUEST_ACCEPTED_BY_OTHER,
                messageSnapshot: nextRequest.message ?? null,
              },
            ]
          : [
              {
                requestId: nextRequest.id,
                viewerId: recipientId,
                actorId: recipientId,
                counterpartyId: nextRequest.userID,
                type: FRIEND_ACTIVITY_TYPE.REQUEST_REJECTED_BY_ME,
                messageSnapshot: nextRequest.message ?? null,
              },
              {
                requestId: nextRequest.id,
                viewerId: nextRequest.userID,
                actorId: recipientId,
                counterpartyId: recipientId,
                type: FRIEND_ACTIVITY_TYPE.REQUEST_REJECTED_BY_OTHER,
                messageSnapshot: nextRequest.message ?? null,
              },
            ],
      );

      if (decision === FriendState.ACCEPTED) {
        await tx.friendSyncOutbox.createMany({
          data: [
            {
              operation: 'IMPORT_FRIEND',
              userID: nextRequest.userID,
              targetUserID: recipientId,
            },
            {
              operation: 'IMPORT_FRIEND',
              userID: recipientId,
              targetUserID: nextRequest.userID,
            },
          ],
          skipDuplicates: true,
        });
      }

      return nextRequest;
    });
    await this.broadcastFriendUnreadUpdates([recipientId, record.userID]);
    // Notify the requester first — it's the user-facing signal and only touches
    // the DB + realtime channel, so it stays fast.
    await this.createAndBroadcastFriendRequestNotification({
      type:
        decision === FriendState.ACCEPTED
          ? NotificationType.FRIEND_REQUEST_ACCEPTED
          : NotificationType.FRIEND_REQUEST_REJECTED,
      toUserId: record.userID,
      fromUserId: recipientId,
      content: nextRequest.message ?? '',
    });
    if (decision === FriendState.ACCEPTED) {
      // Fire-and-forget: seeding the opening chat messages goes through up to
      // four sequential OpenIM calls, so awaiting it would stall the accept
      // response for up to ~20s if OpenIM is degraded. The friendship and the
      // OpenIM friend import are already durable (transaction + friendSyncOutbox
      // IMPORT_FRIEND rows); the greeting is a best-effort side effect. The
      // method is fully self-contained (catches + logs), so this never rejects.
      void this.emitAcceptedFriendChatMessages({
        requesterUserID: nextRequest.userID,
        accepterUserID: recipientId,
        requestMessage: nextRequest.message ?? '',
      });
    }
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent:
        decision === FriendState.ACCEPTED
          ? 'friend_request_accepted'
          : 'friend_request_rejected',
      actorId: recipientId,
      targetId: record.userID,
      result: 'success',
      entityType: 'friend_request',
      entityId: requestId,
    });
  }

  // ─── Remove friend ────────────────────────────────────────────────────────────

  async removeFriend(userId: string, friendId: string): Promise<void> {
    const record = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: userId, friendID: friendId },
          { userID: friendId, friendID: userId },
        ],
        state: FriendState.ACCEPTED,
      },
    });
    if (!record) {
      throw new NotFoundException({
        message: 'Friendship not found',
        errorCode: FriendErrorCode.FriendshipNotFound,
      });
    }
    await this.prisma.$transaction(async (tx: any) => {
      await tx.friend.delete({ where: { id: record.id } });
      await tx.friendSyncOutbox.createMany({
        data: [
          {
            operation: 'DELETE_FRIEND',
            userID: userId,
            targetUserID: friendId,
          },
          {
            operation: 'DELETE_FRIEND',
            userID: friendId,
            targetUserID: userId,
          },
        ],
        skipDuplicates: true,
      });
    });
  }

  async reportFriend(
    reporterId: string,
    friendUserId: string,
    dto: ReportFriendDto,
  ): Promise<void> {
    if (reporterId === friendUserId) {
      throw new BadRequestException({
        message: 'Cannot report yourself',
        errorCode: FriendErrorCode.ReportSelf,
      });
    }

    const target = await this.prisma.user.findUnique({
      where: { id: friendUserId },
      select: { id: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: FriendErrorCode.UserNotFound,
      });
    }

    const friendship = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: reporterId, friendID: friendUserId },
          { userID: friendUserId, friendID: reporterId },
        ],
        state: FriendState.ACCEPTED,
      },
      select: { id: true },
    });
    if (!friendship) {
      throw new NotFoundException({
        message: 'Friendship not found',
        errorCode: FriendErrorCode.FriendshipNotFound,
      });
    }

    // Prevent duplicate live reports for the same reporter / target / category.
    // A previously REJECTED report doesn't block a fresh one (the reporter may
    // have a genuine new incident) — only PENDING/APPROVED reports do. The
    // partial unique index `FriendReport_active_report_key` (WHERE status <>
    // 'REJECTED') is the authoritative backstop; the catch below turns the
    // race-loser's P2002 into the same clean conflict.
    const duplicate = await this.prisma.friendReport.findFirst({
      where: {
        reporterID: reporterId,
        targetID: friendUserId,
        category: dto.category,
        status: {
          in: [FriendReportStatus.PENDING, FriendReportStatus.APPROVED],
        },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException({
        message:
          'You have already submitted a report for this category against this user',
        errorCode: FriendErrorCode.ReportDuplicate,
      });
    }

    // Reports no longer deduct credit on submission — they are queued as
    // PENDING and only affect the target's credit once an admin approves them
    // (see FriendReportAdminService). This prevents brigading from silently
    // tanking a user's score with no review.
    try {
      await this.prisma.friendReport.create({
        data: {
          reporterID: reporterId,
          targetID: friendUserId,
          category: dto.category,
          description: dto.description.trim(),
          evidence: dto.evidence ?? [],
        },
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message:
            'You have already submitted a report for this category against this user',
          errorCode: FriendErrorCode.ReportDuplicate,
        });
      }
      throw error;
    }

    this.logger.warn(
      `Friend report submitted: ${reporterId} → ${friendUserId} (${dto.category})`,
    );
  }

  // ─── Lists ────────────────────────────────────────────────────────────────────

  async listFriends(userId: string): Promise<FriendProfileDto[]> {
    const records = await this.prisma.friend.findMany({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: FriendState.ACCEPTED,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const friendIds = records.map((r) =>
      r.userID === userId ? r.friendID : r.userID,
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: friendIds }, status: 'ACTIVE' },
      select: FRIEND_PROFILE_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return records
      .map((r) => {
        const fid = r.userID === userId ? r.friendID : r.userID;
        const u = userMap.get(fid);
        if (!u) return null;
        return { ...u, friendsSince: r.updatedAt } as FriendProfileDto;
      })
      .filter((x): x is FriendProfileDto => x !== null);
  }

  async getFriendSettings(
    userId: string,
    friendUserId: string,
  ): Promise<FriendSettingsDto> {
    const friendship = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: userId, friendID: friendUserId },
          { userID: friendUserId, friendID: userId },
        ],
        state: FriendState.ACCEPTED,
      },
    });

    if (!friendship) {
      throw new NotFoundException({
        message: 'Friendship not found',
        errorCode: FriendErrorCode.FriendshipNotFound,
      });
    }

    const [availableTags, assignedLinks] = await Promise.all([
      this.prisma.friendTag.findMany({
        where: { ownerID: userId },
        orderBy: { name: 'asc' },
      }),
      this.prisma.friendTagOnFriend.findMany({
        where: {
          ownerID: userId,
          friendID: friendship.id,
        },
        include: {
          tag: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      }),
    ]);

    return {
      remark:
        friendship.userID === userId ? friendship.remarkA : friendship.remarkB,
      assignedTags: assignedLinks.map((link) => link.tag),
      availableTags,
    };
  }

  async listIncomingRequests(userId: string): Promise<FriendRequestDto[]> {
    const records = await this.prisma.friend.findMany({
      where: { friendID: userId, state: FriendState.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    const senderIds = records.map((r) => r.userID);
    const users = await this.prisma.user.findMany({
      where: { id: { in: senderIds }, status: 'ACTIVE' },
      select: MINI_USER_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return records
      .filter((r) => userMap.has(r.userID))
      .map((r) => ({
        id: r.id,
        state: r.state,
        createdAt: r.createdAt,
        message: r.message,
        user: userMap.get(r.userID)!,
      }));
  }

  async listOutgoingRequests(userId: string): Promise<FriendRequestDto[]> {
    const records = await this.prisma.friend.findMany({
      where: { userID: userId, state: FriendState.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    const targetIds = records.map((r) => r.friendID);
    const users = await this.prisma.user.findMany({
      where: { id: { in: targetIds }, status: 'ACTIVE' },
      select: MINI_USER_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return records
      .filter((r) => userMap.has(r.friendID))
      .map((r) => ({
        id: r.id,
        state: r.state,
        createdAt: r.createdAt,
        message: r.message,
        user: userMap.get(r.friendID)!,
      }));
  }

  async listActivities(userId: string): Promise<FriendActivityDto[]> {
    await this.backfillLegacyActivitiesForViewer(userId);

    const activities = await this.prisma.friendActivity.findMany({
      where: { viewerId: userId },
      orderBy: { createdAt: 'desc' },
      include: FRIEND_ACTIVITY_INCLUDE,
    });

    return activities.map((activity) => this.toFriendActivityDto(activity));
  }

  async getUnreadActivityCount(
    userId: string,
  ): Promise<FriendActivityUnreadCountDto> {
    await this.backfillLegacyActivitiesForViewer(userId);

    const count = await this.prisma.friendActivity.count({
      where: { viewerId: userId, readAt: null },
    });

    return { count };
  }

  async getActivity(
    userId: string,
    activityId: string,
  ): Promise<FriendActivityDto> {
    const activity = await this.prisma.friendActivity.findFirst({
      where: { id: activityId, viewerId: userId },
      include: FRIEND_ACTIVITY_INCLUDE,
    });

    if (!activity) {
      throw new NotFoundException({
        message: 'Friend activity not found',
        errorCode: FriendErrorCode.ActivityNotFound,
      });
    }

    return this.toFriendActivityDto(activity);
  }

  async markActivityRead(userId: string, activityId: string): Promise<void> {
    const result = await this.prisma.friendActivity.updateMany({
      where: { id: activityId, viewerId: userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      const activity = await this.prisma.friendActivity.findFirst({
        where: { id: activityId, viewerId: userId },
      });

      if (!activity) {
        throw new NotFoundException({
          message: 'Friend activity not found',
          errorCode: FriendErrorCode.ActivityNotFound,
        });
      }
    }

    await this.broadcastFriendUnreadUpdates([userId]);
  }

  // ─── Relationship status ─────────────────────────────────────────────────────

  async getStatus(
    viewerId: string,
    targetId: string,
  ): Promise<FriendStatusDto> {
    // Block wins over everything. Run both lookups in parallel — the friend
    // query result is simply discarded if a block exists.
    const [block, record] = await Promise.all([
      this.prisma.block.findFirst({
        where: {
          OR: [
            { blockerID: viewerId, blockedID: targetId },
            { blockerID: targetId, blockedID: viewerId },
          ],
        },
      }),
      this.prisma.friend.findFirst({
        where: {
          OR: [
            { userID: viewerId, friendID: targetId },
            { userID: targetId, friendID: viewerId },
          ],
          state: { in: [FriendState.PENDING, FriendState.ACCEPTED] },
        },
      }),
    ]);
    if (block) {
      return { status: 'BLOCKED', requestId: null };
    }

    if (!record) return { status: 'NONE', requestId: null };
    if (record.state === FriendState.ACCEPTED)
      return { status: 'ACCEPTED', requestId: record.id };
    if (record.userID === viewerId)
      return { status: 'PENDING_SENT', requestId: record.id };
    return { status: 'PENDING_RECEIVED', requestId: record.id };
  }

  // ─── Block / Unblock ─────────────────────────────────────────────────────────

  async blockUser(blockerId: string, targetId: string): Promise<void> {
    if (blockerId === targetId) {
      throw new BadRequestException({
        message: 'Cannot block yourself',
        errorCode: FriendErrorCode.BlockSelf,
      });
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: FriendErrorCode.UserNotFound,
      });
    }

    const already = await this.prisma.block.findUnique({
      where: {
        blockerID_blockedID: { blockerID: blockerId, blockedID: targetId },
      },
    });
    if (already)
      throw new ConflictException({
        message: 'User already blocked',
        errorCode: FriendErrorCode.AlreadyBlocked,
      });

    // Remove friendship if exists (any state) in a transaction.
    // The pre-check above is a fast path; the catch handles the race where a
    // concurrent block call wins between the findUnique and the create, so the
    // client still sees a clean 409 instead of a leaked Prisma constraint name.
    try {
      await this.prisma.$transaction(async (tx: any) => {
        await tx.friend.deleteMany({
          where: {
            OR: [
              { userID: blockerId, friendID: targetId },
              { userID: targetId, friendID: blockerId },
            ],
          },
        });
        await tx.block.create({
          data: { blockerID: blockerId, blockedID: targetId },
        });
        await tx.friendSyncOutbox.createMany({
          data: [
            {
              operation: 'ADD_BLACKLIST',
              userID: blockerId,
              targetUserID: targetId,
            },
            {
              operation: 'DELETE_FRIEND',
              userID: blockerId,
              targetUserID: targetId,
            },
            {
              operation: 'DELETE_FRIEND',
              userID: targetId,
              targetUserID: blockerId,
            },
          ],
          skipDuplicates: true,
        });
      });
    } catch (error) {
      if (this.isPrismaUniqueConstraintError(error)) {
        throw new ConflictException({
          message: 'User already blocked',
          errorCode: FriendErrorCode.AlreadyBlocked,
        });
      }
      throw error;
    }

    this.logger.log(`Block created: ${blockerId} → ${targetId}`);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'friend_block_created',
      actorId: blockerId,
      targetId,
      result: 'success',
      entityType: 'block',
      entityId: `${blockerId}:${targetId}`,
    });
  }

  async unblockUser(blockerId: string, targetId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx: any) => {
        await tx.block.delete({
          where: {
            blockerID_blockedID: { blockerID: blockerId, blockedID: targetId },
          },
        });
        await tx.friendSyncOutbox.createMany({
          data: [
            {
              operation: 'REMOVE_BLACKLIST',
              userID: blockerId,
              targetUserID: targetId,
            },
          ],
          skipDuplicates: true,
        });
      });
    } catch (error) {
      // P2025 = record to delete does not exist.
      if (this.prismaErrorCode(error) === 'P2025') {
        throw new NotFoundException({
          message: 'Block not found',
          errorCode: FriendErrorCode.BlockNotFound,
        });
      }
      throw error;
    }
  }

  async listBlocked(userId: string) {
    const blocks = await this.prisma.block.findMany({
      where: { blockerID: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        blocked: { select: MINI_USER_SELECT },
      },
    });
    return blocks.map((b) => ({ ...b.blocked, blockedAt: b.createdAt }));
  }

  // ─── Remark ───────────────────────────────────────────────────────────────────

  /**
   * Set (or clear) the private remark a user has for one of their friends.
   * Remark is stored on the shared Friend record:
   *   remarkA = userID's label for friendID
   *   remarkB = friendID's label for userID
   */
  async setRemark(
    userId: string,
    friendUserId: string,
    remark: string | null,
  ): Promise<void> {
    const record = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: userId, friendID: friendUserId },
          { userID: friendUserId, friendID: userId },
        ],
        state: FriendState.ACCEPTED,
      },
    });
    if (!record)
      throw new NotFoundException({
        message: 'Friendship not found',
        errorCode: FriendErrorCode.FriendshipNotFound,
      });

    const field = record.userID === userId ? 'remarkA' : 'remarkB';
    await this.prisma.friend.update({
      where: { id: record.id },
      data: { [field]: remark },
    });
  }

  // ─── Friend tags ──────────────────────────────────────────────────────────────

  async listMyTags(userId: string) {
    return this.prisma.friendTag.findMany({
      where: { ownerID: userId },
      orderBy: { name: 'asc' },
    });
  }

  async createTag(userId: string, name: string, color?: string) {
    const trimmed = name.trim();
    if (!trimmed)
      throw new BadRequestException({
        message: 'Tag name cannot be empty',
        errorCode: FriendErrorCode.TagNameEmpty,
      });

    // Only enforce the cap when this would be a *new* tag — re-submitting an
    // existing name is an idempotent color update and must stay allowed.
    const existing = await this.prisma.friendTag.findUnique({
      where: { ownerID_name: { ownerID: userId, name: trimmed } },
      select: { id: true },
    });
    if (!existing) {
      const tagCount = await this.prisma.friendTag.count({
        where: { ownerID: userId },
      });
      if (tagCount >= MAX_FRIEND_TAGS_PER_USER) {
        throw new BadRequestException({
          message: `Friend tag limit reached (${MAX_FRIEND_TAGS_PER_USER}).`,
          errorCode: FriendErrorCode.TagLimitReached,
        });
      }
    }

    return this.prisma.friendTag.upsert({
      where: { ownerID_name: { ownerID: userId, name: trimmed } },
      update: { color: color ?? undefined },
      create: { ownerID: userId, name: trimmed, color: color ?? null },
    });
  }

  async deleteTag(userId: string, tagId: string): Promise<void> {
    const tag = await this.prisma.friendTag.findUnique({
      where: { id: tagId },
    });
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException({
        message: 'Tag not found',
        errorCode: FriendErrorCode.TagNotFound,
      });
    await this.prisma.friendTag.delete({ where: { id: tagId } });
  }

  /** Assign a tag to a friendship (idempotent). */
  async assignTag(
    userId: string,
    friendUserId: string,
    tagId: string,
  ): Promise<void> {
    const [friendship, tag] = await Promise.all([
      this.prisma.friend.findFirst({
        where: {
          OR: [
            { userID: userId, friendID: friendUserId },
            { userID: friendUserId, friendID: userId },
          ],
          state: FriendState.ACCEPTED,
        },
      }),
      this.prisma.friendTag.findUnique({ where: { id: tagId } }),
    ]);

    if (!friendship)
      throw new NotFoundException({
        message: 'Friendship not found',
        errorCode: FriendErrorCode.FriendshipNotFound,
      });
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException({
        message: 'Tag not found',
        errorCode: FriendErrorCode.TagNotFound,
      });

    await this.prisma.friendTagOnFriend.upsert({
      where: {
        ownerID_tagID_friendID: {
          ownerID: userId,
          tagID: tagId,
          friendID: friendship.id,
        },
      },
      update: {},
      create: { ownerID: userId, tagID: tagId, friendID: friendship.id },
    });
  }

  /** Remove a tag from a friendship. */
  async removeTag(
    userId: string,
    friendUserId: string,
    tagId: string,
  ): Promise<void> {
    const [friendship, tag] = await Promise.all([
      this.prisma.friend.findFirst({
        where: {
          OR: [
            { userID: userId, friendID: friendUserId },
            { userID: friendUserId, friendID: userId },
          ],
          state: FriendState.ACCEPTED,
        },
      }),
      this.prisma.friendTag.findUnique({ where: { id: tagId } }),
    ]);

    if (!friendship)
      throw new NotFoundException({
        message: 'Friendship not found',
        errorCode: FriendErrorCode.FriendshipNotFound,
      });
    // Validate tag ownership for parity with assignTag — a wrong/foreign
    // tagId is a 404 rather than a silent no-op.
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException({
        message: 'Tag not found',
        errorCode: FriendErrorCode.TagNotFound,
      });

    await this.prisma.friendTagOnFriend.deleteMany({
      where: { ownerID: userId, tagID: tagId, friendID: friendship.id },
    });
  }

  /** List all friends that have a given tag. */
  async listFriendsByTag(
    userId: string,
    tagId: string,
  ): Promise<FriendProfileDto[]> {
    const tag = await this.prisma.friendTag.findUnique({
      where: { id: tagId },
    });
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException({
        message: 'Tag not found',
        errorCode: FriendErrorCode.TagNotFound,
      });

    const links = await this.prisma.friendTagOnFriend.findMany({
      where: { ownerID: userId, tagID: tagId },
      include: { friendship: true },
    });

    const friendUserIds = links.map((l) => {
      const f = l.friendship;
      return f.userID === userId ? f.friendID : f.userID;
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: friendUserIds }, status: 'ACTIVE' },
      select: FRIEND_PROFILE_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return links
      .map((l) => {
        const f = l.friendship;
        const fid = f.userID === userId ? f.friendID : f.userID;
        const u = userMap.get(fid);
        if (!u) return null;
        return { ...u, friendsSince: f.updatedAt } as FriendProfileDto;
      })
      .filter((x): x is FriendProfileDto => x !== null);
  }

  private async createFriendActivities(
    tx: any,
    activities: Array<{
      requestId: string;
      viewerId: string;
      actorId: string;
      counterpartyId: string;
      type: FriendActivityType;
      messageSnapshot?: string | null;
    }>,
  ) {
    if (activities.length === 0) {
      return;
    }

    // skipDuplicates: the (requestId, viewerId, type) unique index makes this
    // idempotent if the same activity is ever written twice.
    await tx.friendActivity.createMany({
      data: activities,
      skipDuplicates: true,
    });
  }

  private async broadcastFriendUnreadUpdates(userIds: string[]) {
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    await Promise.all(
      uniqueUserIds.map((userId) =>
        this.realtimeService.broadcastFriendUnreadCount(userId),
      ),
    );
  }

  private async createAndBroadcastFriendRequestNotification(params: {
    type:
      | typeof NotificationType.FRIEND_REQUEST_RECEIVED
      | typeof NotificationType.FRIEND_REQUEST_ACCEPTED
      | typeof NotificationType.FRIEND_REQUEST_REJECTED;
    toUserId: string;
    fromUserId: string;
    content: string;
  }): Promise<void> {
    try {
      const notification =
        await this.notificationService.createFriendRequestNotification(params);
      if (!notification) {
        return;
      }

      await this.realtimeService.broadcastInteractionUnread(params.toUserId);
      this.realtimeService.broadcastNotificationCreated(
        params.toUserId,
        notification,
      );
    } catch (error) {
      this.logger.warn(
        `Friend notification side effect failed: ${params.type} ${params.fromUserId} -> ${params.toUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async emitAcceptedFriendChatMessages(params: {
    requesterUserID: string;
    accepterUserID: string;
    requestMessage: string;
  }) {
    try {
      const [requester, accepter] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: params.requesterUserID },
          select: { nickname: true, accountId: true, avatarUrl: true },
        }),
        this.prisma.user.findUnique({
          where: { id: params.accepterUserID },
          select: { nickname: true, accountId: true, avatarUrl: true },
        }),
      ]);
      const requesterName = this.displayNameForAcceptedFriendMessage(
        requester,
        params.requesterUserID,
      );
      const accepterName = this.displayNameForAcceptedFriendMessage(
        accepter,
        params.accepterUserID,
      );
      const greeting = params.requestMessage.trim() || `我是${requesterName}`;

      // Import both directions synchronously here (in addition to the durable
      // friendSyncOutbox IMPORT_FRIEND rows written inside handleRequest's
      // transaction) because the greeting messages below must land in an
      // established friendship — the async outbox worker may not have run yet.
      // OpenIM's import_friend is idempotent, so the double write is harmless.
      await this.openimService.importFriends(params.requesterUserID, [
        params.accepterUserID,
      ]);
      await this.openimService.importFriends(params.accepterUserID, [
        params.requesterUserID,
      ]);
      await this.openimService.sendTextMessage({
        sendID: params.requesterUserID,
        recvID: params.accepterUserID,
        content: greeting,
        senderNickname: requesterName,
        senderFaceURL: requester?.avatarUrl ?? '',
      });
      await this.openimService.sendTextMessage({
        sendID: params.accepterUserID,
        recvID: params.requesterUserID,
        content: FRIEND_ACCEPTED_REPLY_MESSAGE,
        senderNickname: accepterName,
        senderFaceURL: accepter?.avatarUrl ?? '',
      });
    } catch (error) {
      this.logger.warn(
        `Accepted friend chat messages failed: ${params.requesterUserID} <-> ${
          params.accepterUserID
        }: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private displayNameForAcceptedFriendMessage(
    user:
      | { nickname?: string | null; accountId?: string | null }
      | null
      | undefined,
    fallbackUserID: string,
  ) {
    return user?.nickname?.trim() || user?.accountId?.trim() || fallbackUserID;
  }

  private async throwActiveFriendConflict(
    senderId: string,
    targetId: string,
  ): Promise<never> {
    const active = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: senderId, friendID: targetId },
          { userID: targetId, friendID: senderId },
        ],
        state: { in: [FriendState.PENDING, FriendState.ACCEPTED] },
      },
      select: { state: true },
    });

    if (active?.state === FriendState.ACCEPTED) {
      throw new ConflictException({
        message: 'Already friends',
        errorCode: FriendErrorCode.AlreadyFriends,
      });
    }
    throw new ConflictException({
      message: 'Friend request already pending',
      errorCode: FriendErrorCode.RequestAlreadyPending,
    });
  }

  private prismaErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    return this.prismaErrorCode(error) === 'P2002';
  }

  private async syncPendingFriendTagLinks(
    tx: any,
    ownerId: string,
    requestId: string,
    tagIds: string[],
  ) {
    await tx.pendingFriendTagOnRequest.deleteMany({
      where: { requestID: requestId },
    });

    if (tagIds.length === 0) {
      return;
    }

    await tx.pendingFriendTagOnRequest.createMany({
      data: tagIds.map((tagID) => ({
        ownerID: ownerId,
        requestID: requestId,
        tagID,
      })),
    });
  }

  private async promotePendingFriendTags(
    tx: any,
    request: {
      id: string;
      userID: string;
    },
  ) {
    const pendingLinks = await tx.pendingFriendTagOnRequest.findMany({
      where: {
        requestID: request.id,
        ownerID: request.userID,
      },
      select: {
        tagID: true,
      },
    });

    if (pendingLinks.length === 0) {
      return;
    }

    const pendingTagIds = pendingLinks.map(
      (link: { tagID: string }) => link.tagID,
    );
    const existingTags = await tx.friendTag.findMany({
      where: {
        ownerID: request.userID,
        id: { in: pendingTagIds },
      },
      select: { id: true },
    });

    if (existingTags.length === 0) {
      return;
    }

    await tx.friendTagOnFriend.createMany({
      data: existingTags.map((tag: { id: string }) => ({
        ownerID: request.userID,
        tagID: tag.id,
        friendID: request.id,
      })),
    });
  }

  private async backfillLegacyActivitiesForViewer(userId: string) {
    // One-time migration gate: skip the (potentially full-table) scan below
    // once this viewer has been backfilled. Without this the backfill ran on
    // every listActivities / getUnreadActivityCount call (a polled endpoint).
    const viewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activitiesBackfilledAt: true },
    });
    if (!viewer || viewer.activitiesBackfilledAt) {
      return;
    }

    const requests = await this.prisma.friend.findMany({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: {
          in: [
            FriendState.PENDING,
            FriendState.ACCEPTED,
            FriendState.REJECTED,
            FriendState.WITHDRAWN,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (requests.length === 0) {
      await this.markViewerBackfilled(userId);
      return;
    }

    const existingActivities = await this.prisma.friendActivity.findMany({
      where: {
        viewerId: userId,
        requestId: { in: requests.map((request) => request.id) },
      },
      select: { requestId: true, type: true },
    });

    const existingKeys = new Set(
      existingActivities.map(
        (activity) => `${activity.requestId}:${activity.type}`,
      ),
    );
    const missingActivities: Array<{
      requestId: string;
      viewerId: string;
      actorId: string;
      counterpartyId: string;
      type: FriendActivityType;
      messageSnapshot?: string | null;
      createdAt: Date;
    }> = [];

    for (const request of requests) {
      const backfillActivity = this.getLegacyBackfillActivity(userId, request);

      if (!backfillActivity) {
        continue;
      }

      const key = `${request.id}:${backfillActivity.type}`;

      if (existingKeys.has(key)) {
        continue;
      }

      missingActivities.push({
        requestId: request.id,
        viewerId: userId,
        actorId: backfillActivity.actorId,
        counterpartyId: backfillActivity.counterpartyId,
        type: backfillActivity.type,
        messageSnapshot: request.message ?? null,
        createdAt: request.updatedAt ?? request.createdAt,
      });
    }

    if (missingActivities.length === 0) {
      await this.markViewerBackfilled(userId);
      return;
    }

    // skipDuplicates is meaningful now that FriendActivity has a unique index
    // on (requestId, viewerId, type) — a concurrent backfill can't double-write.
    await this.prisma.friendActivity.createMany({
      data: missingActivities,
      skipDuplicates: true,
    });
    await this.markViewerBackfilled(userId);
  }

  private async markViewerBackfilled(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { activitiesBackfilledAt: new Date() },
    });
  }

  private getLegacyBackfillActivity(
    userId: string,
    request: {
      id: string;
      userID: string;
      friendID: string;
      state: FriendState | string;
      message?: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ): {
    actorId: string;
    counterpartyId: string;
    type: FriendActivityType;
  } | null {
    if (request.state === FriendState.PENDING) {
      if (request.userID === userId) {
        return {
          actorId: request.userID,
          counterpartyId: request.friendID,
          type: FRIEND_ACTIVITY_TYPE.REQUEST_SENT,
        };
      }

      return {
        actorId: request.userID,
        counterpartyId: request.userID,
        type: FRIEND_ACTIVITY_TYPE.REQUEST_RECEIVED,
      };
    }

    if (request.state === FriendState.ACCEPTED) {
      if (request.userID === userId) {
        return {
          actorId: request.friendID,
          counterpartyId: request.friendID,
          type: FRIEND_ACTIVITY_TYPE.REQUEST_ACCEPTED_BY_OTHER,
        };
      }

      return {
        actorId: request.friendID,
        counterpartyId: request.userID,
        type: FRIEND_ACTIVITY_TYPE.REQUEST_ACCEPTED_BY_ME,
      };
    }

    if (request.state === FriendState.REJECTED) {
      if (request.userID === userId) {
        return {
          actorId: request.friendID,
          counterpartyId: request.friendID,
          type: FRIEND_ACTIVITY_TYPE.REQUEST_REJECTED_BY_OTHER,
        };
      }

      return {
        actorId: request.friendID,
        counterpartyId: request.userID,
        type: FRIEND_ACTIVITY_TYPE.REQUEST_REJECTED_BY_ME,
      };
    }

    if (
      request.state === FriendState.WITHDRAWN &&
      request.friendID === userId
    ) {
      return {
        actorId: request.userID,
        counterpartyId: request.userID,
        type: FRIEND_ACTIVITY_TYPE.REQUEST_WITHDRAWN_BY_OTHER,
      };
    }

    return null;
  }

  private toFriendActivityDto(activity: {
    id: string;
    type: string;
    requestId: string;
    messageSnapshot: string | null;
    readAt: Date | null;
    createdAt: Date;
    counterparty: {
      id: string;
      accountId: string;
      nickname: string;
      avatarUrl: string | null;
    };
    request: {
      id: string;
      state: string;
      message: string | null;
    };
  }): FriendActivityDto {
    return {
      id: activity.id,
      type: activity.type,
      requestId: activity.requestId,
      requestState: activity.request.state,
      messageSnapshot: activity.messageSnapshot ?? activity.request.message,
      readAt: activity.readAt,
      createdAt: activity.createdAt,
      counterparty: activity.counterparty,
    };
  }

  // ─── Helper ───────────────────────────────────────────────────────────────────

  private async assertBelowFriendLimit(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const limit =
      user?.role === 'MEMBER' || user?.role === 'ADMIN'
        ? FRIEND_LIMIT_MEMBER
        : FRIEND_LIMIT_USER;

    const count = await this.prisma.friend.count({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: FriendState.ACCEPTED,
      },
    });

    if (count >= limit) {
      throw new ForbiddenException({
        message: `Friend limit reached (${limit}). Upgrade to MEMBER for a higher limit.`,
        errorCode: FriendErrorCode.LimitReached,
      });
    }
  }
}
