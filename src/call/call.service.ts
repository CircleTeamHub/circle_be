import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { CallErrorCode } from 'src/common/app-error-codes';
import {
  CallEndReason,
  CallParticipantStatus,
  CallStatus,
  CallType,
  CircleMemberStatus,
  FriendState,
  Prisma,
  UserStatus,
} from 'src/generated/prisma';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CreateDirectCallDto, CreateGroupCallDto } from './dto/call.dto';
import { LiveKitCallService } from './livekit.service';

const GROUP_SESSION_TYPE = 3;
// OpenIM 单聊 sessionType。toCallDto 一直会把非 GROUP 映射成 'single'（此前是死分支）。
const SINGLE_SESSION_TYPE = 1;

type UserLite = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
};

type CallParticipantWithUser = {
  userID: string;
  status: string;
  invitedAt?: Date;
  joinedAt?: Date | null;
  leftAt?: Date | null;
  rejectedAt?: Date | null;
  missedAt?: Date | null;
  user?: UserLite;
};

type CallWithParticipants = {
  id: string;
  conversationID?: string;
  sessionType?: number;
  callType?: string;
  status: string;
  livekitRoomName?: string;
  initiatorID?: string;
  initiator?: UserLite;
  startedAt?: Date | null;
  endedAt?: Date | null;
  expiresAt?: Date;
  endReason?: string | null;
  participants?: CallParticipantWithUser[];
  createdAt?: Date;
};

type LiveKitWebhookEvent = {
  event?: string;
  room?: { name?: string };
};

const userLiteSelect = {
  id: true,
  nickname: true,
  avatarUrl: true,
};

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
    private readonly livekit: LiveKitCallService,
    private readonly realtime: RealtimeService,
    private readonly config: ConfigService,
  ) {}

  async createGroupCall(
    initiatorID: string,
    dto: CreateGroupCallDto,
    idempotencyKey?: string,
  ) {
    const conversationID = this.normalizeID(
      dto.conversationID,
      'Group not found',
    );
    const inviteeIDs = this.uniqueIDs(dto.inviteeIDs).filter(
      (userID) => userID !== initiatorID,
    );
    if (inviteeIDs.length === 0) {
      throw new BadRequestException({
        message: 'CALL_INVITEES_REQUIRED',
        errorCode: CallErrorCode.InviteesRequired,
      });
    }
    this.assertCallTypeEnabled(dto.callType);

    const participantIDs = [initiatorID, ...inviteeIDs];
    this.assertParticipantLimit(participantIDs.length);

    await this.assertGroupMembers(conversationID, participantIDs, initiatorID);
    const users = await this.loadActiveUsers(participantIDs);
    return this.startCall({
      initiatorID,
      conversationID,
      sessionType: GROUP_SESSION_TYPE,
      callType: dto.callType,
      inviteeIDs,
      users,
      idempotencyKey,
    });
  }

  /**
   * 1:1 呼叫（#113）。与群呼共享同一条创建管线（busy 检测/幂等/振铃超时/
   * LiveKit 房间），仅三处不同：成员校验是好友+非拉黑而不是群成员；
   * sessionType 写 1；两人通话不受 CALL_MAX_PARTICIPANTS 约束。
   * 非好友与被拉黑共用 CALL_NOT_FRIEND，不向发起方泄露拉黑事实。
   */
  async createDirectCall(
    initiatorID: string,
    dto: CreateDirectCallDto,
    idempotencyKey?: string,
  ) {
    const calleeID = this.normalizeID(dto.calleeID, 'CALL_NOT_FRIEND');
    if (calleeID === initiatorID) {
      throw new BadRequestException({
        message: 'CALL_INVITEE_INVALID',
        errorCode: CallErrorCode.InviteeInvalid,
      });
    }
    this.assertCallTypeEnabled(dto.callType);
    await this.assertDirectCallee(initiatorID, calleeID);

    const participantIDs = [initiatorID, calleeID];
    const users = await this.loadActiveUsers(participantIDs);
    // 会话 id 用 OpenIM 单聊规约（si_ + 双方 IM id 升序），与客户端会话一致，
    // 通话留痕消息（#115）正好落进同一个会话。
    const conversationID = OpenimService.singleConversationID(
      initiatorID,
      calleeID,
    );
    return this.startCall({
      initiatorID,
      conversationID,
      sessionType: SINGLE_SESSION_TYPE,
      callType: dto.callType,
      inviteeIDs: [calleeID],
      users,
      idempotencyKey,
    });
  }

  /**
   * 重连对账（Circle_frontend#93）：断线恢复后客户端问「我现在在通话里吗」，
   * 而不是靠可能漏掉的事件推断。只返回自己仍是 INVITED/JOINED 的
   * RINGING/ACTIVE 会话。
   */
  async getCurrentCall(userID: string) {
    const call = (await this.prisma.callSession.findFirst({
      where: {
        status: { in: [CallStatus.RINGING, CallStatus.ACTIVE] },
        participants: {
          some: {
            userID,
            status: {
              in: [CallParticipantStatus.INVITED, CallParticipantStatus.JOINED],
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: this.callInclude(),
    })) as CallWithParticipants | null;

    if (!call) {
      return { call: null, selfParticipant: null };
    }
    return {
      call: this.toCallDto(call),
      selfParticipant: this.toParticipantDto(
        this.findParticipant(call, userID),
      ),
    };
  }

  private async startCall(params: {
    initiatorID: string;
    conversationID: string;
    sessionType: number;
    callType: CallType;
    inviteeIDs: string[];
    users: Map<string, UserLite>;
    idempotencyKey?: string;
  }) {
    const {
      initiatorID,
      conversationID,
      sessionType,
      callType,
      inviteeIDs,
      users,
      idempotencyKey,
    } = params;
    const participantIDs = [initiatorID, ...inviteeIDs];
    await this.expireStaleRingingCallsForUsers(participantIDs);
    const existing = await this.findIdempotentCreateCall(
      initiatorID,
      idempotencyKey,
    );
    if (existing) {
      const token = await this.mintToken(existing, users.get(initiatorID)!);
      return {
        call: this.toCallDto(existing),
        selfParticipant: this.toParticipantDto(
          this.findParticipant(existing, initiatorID),
        ),
        livekit: this.buildTokenResponse(token),
      };
    }
    await this.assertNotBusy(participantIDs);

    const callId = randomUUID();
    const livekitRoomName = `circle_call_${callId.replace(/-/g, '')}`;
    const expiresAt = this.dateAfterSeconds(this.ringTimeoutSeconds());
    const joinedAt = new Date();

    await this.livekit.createRoom({
      name: livekitRoomName,
      maxParticipants: this.maxParticipants(),
      metadata: JSON.stringify({ callId, conversationID }),
    });

    let call: CallWithParticipants;
    try {
      call = (await this.prisma.$transaction(
        async (tx) => {
          await this.lockParticipantsForCall(participantIDs, tx);
          await this.assertNotBusy(participantIDs, tx);
          return tx.callSession.create({
            data: {
              id: callId,
              conversationID,
              sessionType,
              callType,
              status: CallStatus.RINGING,
              livekitRoomName,
              initiatorID,
              expiresAt,
              metadata: idempotencyKey ? { idempotencyKey } : undefined,
              participants: {
                create: participantIDs.map((userID) => ({
                  userID,
                  status:
                    userID === initiatorID
                      ? CallParticipantStatus.JOINED
                      : CallParticipantStatus.INVITED,
                  joinedAt: userID === initiatorID ? joinedAt : null,
                  lastTokenAt: userID === initiatorID ? joinedAt : null,
                })),
              },
            },
            include: this.callInclude(),
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )) as CallWithParticipants;
    } catch (error) {
      await this.livekit.deleteRoom(livekitRoomName);
      throw error;
    }

    let token: string;
    try {
      token = await this.mintToken(call, users.get(initiatorID)!);
    } catch (error) {
      await this.failRingingCallAsError(call, new Date());
      throw error;
    }
    const response = this.buildTokenResponse(token);
    const invitePayload = {
      callId: call.id,
      conversationID,
      sessionType:
        sessionType === GROUP_SESSION_TYPE
          ? ('group' as const)
          : ('single' as const),
      callType,
      initiator: users.get(initiatorID)!,
      invitees: inviteeIDs.map((id) => users.get(id)!),
      expiresAt: expiresAt.toISOString(),
      createdAt: (call.createdAt ?? joinedAt).toISOString(),
    };

    await this.realtime.safeBroadcastAll(
      inviteeIDs.map(
        (userID) => () =>
          this.realtime.broadcastCallInvite(userID, invitePayload),
      ),
    );
    this.logger.log(
      `call.created callId=${call.id} conversationID=${conversationID} participants=${participantIDs.length}`,
    );

    return {
      call: this.toCallDto(call),
      selfParticipant: this.toParticipantDto(
        this.findParticipant(call, initiatorID),
      ),
      livekit: response,
    };
  }

  async acceptCall(userID: string, callId: string) {
    const participant = await this.findParticipantForUser(callId, userID);
    if (participant.status === CallParticipantStatus.JOINED) {
      const call = participant.call as CallWithParticipants;
      if (
        call.status !== CallStatus.RINGING &&
        call.status !== CallStatus.ACTIVE
      ) {
        throw new ConflictException({
          message: 'CALL_ENDED',
          errorCode: CallErrorCode.Ended,
        });
      }
      const token = await this.mintToken(call, participant.user);
      return {
        call: this.toCallDto(call),
        selfParticipant: this.toParticipantDto(participant),
        livekit: this.buildTokenResponse(token),
      };
    }
    if (participant.status !== CallParticipantStatus.INVITED) {
      throw new ConflictException({
        message: 'CALL_NOT_INVITED',
        errorCode: CallErrorCode.NotInvited,
      });
    }

    const call = participant.call as CallWithParticipants;
    if (
      call.status !== CallStatus.RINGING &&
      call.status !== CallStatus.ACTIVE
    ) {
      throw new ConflictException({
        message: 'CALL_ENDED',
        errorCode: CallErrorCode.Ended,
      });
    }
    if (call.expiresAt && call.expiresAt.getTime() < Date.now()) {
      await this.expireRingingCallAsMissed(call, new Date());
      throw new ConflictException({
        message: 'CALL_EXPIRED',
        errorCode: CallErrorCode.Expired,
      });
    }

    const joinedAt = new Date();
    const updatedParticipant = await this.prisma.callParticipant.update({
      where: { callID_userID: { callID: callId, userID } },
      data: {
        status: CallParticipantStatus.JOINED,
        joinedAt,
        lastTokenAt: joinedAt,
      },
      include: { user: { select: userLiteSelect } },
    });

    const updatedCall =
      call.status === CallStatus.RINGING
        ? await this.prisma.callSession.update({
            where: { id: callId },
            data: { status: CallStatus.ACTIVE, startedAt: joinedAt },
            include: this.callInclude(),
          })
        : call;

    const token = await this.mintToken(call, updatedParticipant.user);
    const payload = {
      callId,
      user: updatedParticipant.user,
      joinedAt: joinedAt.toISOString(),
      changedAt: joinedAt.toISOString(),
    };
    await this.broadcastToCallParticipants(call, (targetID) =>
      this.realtime.broadcastCallParticipantJoined(targetID, payload),
    );
    this.logger.log(
      `call.participant_joined callId=${callId} userID=${userID}`,
    );

    return {
      call: this.toCallDto(updatedCall as CallWithParticipants),
      selfParticipant: this.toParticipantDto(updatedParticipant),
      livekit: this.buildTokenResponse(token),
    };
  }

  async rejectCall(userID: string, callId: string) {
    const participant = await this.findParticipantForUser(callId, userID);
    if (participant.status === CallParticipantStatus.REJECTED) {
      return participant;
    }
    if (participant.status !== CallParticipantStatus.INVITED) {
      throw new ConflictException({
        message: 'CALL_NOT_INVITED',
        errorCode: CallErrorCode.NotInvited,
      });
    }
    const rejectedAt = new Date();
    const updatedParticipant = await this.prisma.callParticipant.update({
      where: { callID_userID: { callID: callId, userID } },
      data: {
        status: CallParticipantStatus.REJECTED,
        rejectedAt,
      },
      include: { user: { select: userLiteSelect } },
    });
    await this.broadcastToCallParticipants(
      participant.call as CallWithParticipants,
      (targetID) =>
        this.realtime.broadcastCallParticipantRejected(targetID, {
          callId,
          user: updatedParticipant.user,
          rejectedAt: rejectedAt.toISOString(),
          changedAt: rejectedAt.toISOString(),
        }),
    );
    await this.endRingingCallIfNoInviteesRemain(
      participant.call as CallWithParticipants,
      rejectedAt,
    );
    this.logger.log(
      `call.participant_rejected callId=${callId} userID=${userID}`,
    );
    return updatedParticipant;
  }

  async leaveCall(userID: string, callId: string) {
    const participant = await this.findParticipantForUser(callId, userID);
    if (participant.status !== CallParticipantStatus.JOINED) {
      return;
    }

    const leftAt = new Date();
    const updatedParticipant = await this.prisma.callParticipant.update({
      where: { callID_userID: { callID: callId, userID } },
      data: {
        status: CallParticipantStatus.LEFT,
        leftAt,
      },
      include: { user: { select: userLiteSelect } },
    });

    const joinedCount = await this.prisma.callParticipant.count({
      where: {
        callID: callId,
        status: CallParticipantStatus.JOINED,
      },
    });
    if (joinedCount > 0) {
      await this.broadcastToCallParticipants(
        participant.call as CallWithParticipants,
        (targetID) =>
          this.realtime.broadcastCallParticipantLeft(targetID, {
            callId,
            user: updatedParticipant.user,
            leftAt: leftAt.toISOString(),
            changedAt: leftAt.toISOString(),
          }),
      );
      return;
    }

    const call = (participant.call ?? {}) as CallWithParticipants;
    const ended = (await this.prisma.callSession.update({
      where: { id: callId },
      data: {
        status: CallStatus.ENDED,
        endReason: CallEndReason.ALL_LEFT,
        endedAt: leftAt,
        endedByID: userID,
      },
      include: this.callInclude(),
    })) as CallWithParticipants;

    if (call.livekitRoomName) {
      await this.livekit.deleteRoom(call.livekitRoomName);
    }
    await this.broadcastToCallParticipants(ended, (targetID) =>
      this.realtime.broadcastCallEnded(targetID, {
        callId,
        status: CallStatus.ENDED,
        endReason: CallEndReason.ALL_LEFT,
        endedAt: leftAt.toISOString(),
        changedAt: leftAt.toISOString(),
      }),
    );
    this.logger.log(
      `call.ended callId=${callId} reason=${CallEndReason.ALL_LEFT}`,
    );
    this.emitCallRecordMessage(ended, CallEndReason.ALL_LEFT, leftAt);
  }

  async cancelCall(userID: string, callId: string) {
    const call = (await this.prisma.callSession.findUnique({
      where: { id: callId },
      include: this.callInclude(),
    })) as CallWithParticipants | null;
    if (!call) {
      throw new NotFoundException({
        message: 'CALL_NOT_FOUND',
        errorCode: CallErrorCode.NotFound,
      });
    }
    if (call.initiatorID !== userID) {
      throw new ForbiddenException({
        message: 'CALL_NOT_ALLOWED',
        errorCode: CallErrorCode.NotAllowed,
      });
    }
    if (call.status === CallStatus.CANCELED) {
      return this.toCallDto(call);
    }
    if (call.status !== CallStatus.RINGING) {
      throw new ConflictException({
        message: 'CALL_ALREADY_ACTIVE',
        errorCode: CallErrorCode.AlreadyActive,
      });
    }

    const endedAt = new Date();
    await this.prisma.callParticipant.updateMany({
      where: {
        callID: callId,
        status: CallParticipantStatus.INVITED,
      },
      data: {
        status: CallParticipantStatus.MISSED,
        missedAt: endedAt,
      },
    });
    const canceled = (await this.prisma.callSession.update({
      where: { id: callId },
      data: {
        status: CallStatus.CANCELED,
        endReason: CallEndReason.CANCELED,
        endedAt,
        endedByID: userID,
      },
      include: this.callInclude(),
    })) as CallWithParticipants;

    if (call.livekitRoomName) {
      await this.livekit.deleteRoom(call.livekitRoomName);
    }
    await this.broadcastToCallParticipants(canceled, (targetID) =>
      this.realtime.broadcastCallCanceled(targetID, {
        callId,
        status: CallStatus.CANCELED,
        endReason: CallEndReason.CANCELED,
        endedAt: endedAt.toISOString(),
        changedAt: endedAt.toISOString(),
      }),
    );
    this.logger.log(`call.canceled callId=${callId} userID=${userID}`);
    this.emitCallRecordMessage(canceled, CallEndReason.CANCELED, endedAt);
    return this.toCallDto(canceled);
  }

  async createJoinToken(userID: string, callId: string) {
    const participant = await this.findParticipantForUser(callId, userID);
    const call = participant.call as CallWithParticipants;
    if (
      call.status !== CallStatus.RINGING &&
      call.status !== CallStatus.ACTIVE
    ) {
      throw new ConflictException({
        message: 'CALL_ENDED',
        errorCode: CallErrorCode.Ended,
      });
    }
    if (
      call.status === CallStatus.RINGING &&
      call.expiresAt &&
      call.expiresAt.getTime() < Date.now()
    ) {
      await this.expireRingingCallAsMissed(call, new Date());
      throw new ConflictException({
        message: 'CALL_EXPIRED',
        errorCode: CallErrorCode.Expired,
      });
    }
    if (participant.status !== CallParticipantStatus.JOINED) {
      throw new ConflictException({
        message: 'CALL_NOT_ACCEPTED',
        errorCode: CallErrorCode.NotAccepted,
      });
    }
    await this.prisma.callParticipant.update({
      where: { callID_userID: { callID: callId, userID } },
      data: { lastTokenAt: new Date() },
    });
    const token = await this.mintToken(call, participant.user);
    return {
      call: this.toCallDto(call),
      selfParticipant: this.toParticipantDto(participant),
      livekit: this.buildTokenResponse(token),
    };
  }

  async sweepExpiredRingingCalls(limit = 50): Promise<number> {
    const now = new Date();
    const staleCalls = (await this.prisma.callSession.findMany({
      where: { status: CallStatus.RINGING, expiresAt: { lte: now } },
      include: this.callInclude(),
      take: limit,
    })) as CallWithParticipants[];

    for (const call of staleCalls) {
      await this.expireRingingCallAsMissed(call, now);
    }

    return staleCalls.length;
  }

  async handleLiveKitWebhook(event: LiveKitWebhookEvent): Promise<void> {
    if (event.event !== 'room_finished') {
      return;
    }
    const roomName = event.room?.name?.trim();
    if (!roomName) {
      return;
    }
    const call = (await this.prisma.callSession.findUnique({
      where: { livekitRoomName: roomName },
      include: this.callInclude(),
    })) as CallWithParticipants | null;
    if (!call) {
      this.logger.warn(`call.webhook_unknown_room room=${roomName}`);
      return;
    }
    await this.endLiveKitFinishedCall(call, new Date());
  }

  private async findParticipantForUser(callId: string, userID: string) {
    const participant = await this.prisma.callParticipant.findUnique({
      where: { callID_userID: { callID: callId, userID } },
      include: {
        user: { select: userLiteSelect },
        call: {
          include: this.callInclude(),
        },
      },
    });
    if (!participant) {
      throw new NotFoundException({
        message: 'CALL_NOT_FOUND',
        errorCode: CallErrorCode.NotFound,
      });
    }
    return participant;
  }

  private async assertGroupMembers(
    conversationID: string,
    participantIDs: string[],
    initiatorID: string,
  ): Promise<void> {
    const circle = await this.prisma.circle.findFirst({
      where: {
        deleted: false,
        OR: [
          { id: conversationID },
          ...this.groupIDCandidates(conversationID).map((candidate) => ({
            groupID: candidate,
          })),
        ],
      },
      select: { id: true, groupID: true, ownerID: true },
    });

    if (circle) {
      const members = await this.prisma.circleMember.findMany({
        where: {
          circleID: circle.id,
          userID: { in: participantIDs },
        },
        select: { userID: true, status: true },
      });
      const active = new Set(
        members
          .filter((member) => member.status === CircleMemberStatus.ACTIVE)
          .map((member) => member.userID),
      );
      if (!active.has(initiatorID)) {
        throw new ForbiddenException({
          message: 'CALL_NOT_GROUP_MEMBER',
          errorCode: CallErrorCode.NotGroupMember,
        });
      }
      if (!participantIDs.every((userID) => active.has(userID))) {
        throw new BadRequestException({
          message: 'CALL_INVITEE_INVALID',
          errorCode: CallErrorCode.InviteeInvalid,
        });
      }
      return;
    }

    const rawGroupID = this.rawOpenimGroupID(conversationID);
    try {
      const checks = await Promise.all(
        participantIDs.map((userID) =>
          this.openimService.isGroupMember(rawGroupID, userID),
        ),
      );
      if (!checks[0]) {
        throw new ForbiddenException({
          message: 'CALL_NOT_GROUP_MEMBER',
          errorCode: CallErrorCode.NotGroupMember,
        });
      }
      if (checks.some((isMember) => !isMember)) {
        throw new BadRequestException({
          message: 'CALL_INVITEE_INVALID',
          errorCode: CallErrorCode.InviteeInvalid,
        });
      }
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException('Group membership unavailable');
    }
  }

  /**
   * 1:1 呼叫的成员校验（#113）：必须是已接受的好友，且双向都没有拉黑。
   * 两种拒绝共用 CALL_NOT_FRIEND —— 把「对方拉黑了你」翻译成可感知的差异
   * 等于把拉黑状态做成了探测接口。
   */
  private async assertDirectCallee(
    initiatorID: string,
    calleeID: string,
  ): Promise<void> {
    const [friendship, block] = await Promise.all([
      this.prisma.friend.findFirst({
        where: {
          state: FriendState.ACCEPTED,
          OR: [
            { userID: initiatorID, friendID: calleeID },
            { userID: calleeID, friendID: initiatorID },
          ],
        },
        select: { id: true },
      }),
      this.prisma.block.findFirst({
        where: {
          OR: [
            { blockerID: calleeID, blockedID: initiatorID },
            { blockerID: initiatorID, blockedID: calleeID },
          ],
        },
        select: { id: true },
      }),
    ]);
    if (!friendship || block) {
      throw new ForbiddenException({
        message: 'CALL_NOT_FRIEND',
        errorCode: CallErrorCode.NotFriend,
      });
    }
  }

  private async assertNotBusy(
    userIDs: string[],
    prisma: Pick<PrismaService, 'callParticipant'> = this.prisma,
  ): Promise<void> {
    const busy = await prisma.callParticipant.findFirst({
      where: {
        userID: { in: userIDs },
        status: {
          in: [CallParticipantStatus.INVITED, CallParticipantStatus.JOINED],
        },
        call: { status: { in: [CallStatus.RINGING, CallStatus.ACTIVE] } },
      },
      select: { id: true },
    });
    if (busy) {
      throw new ConflictException({
        message: 'CALL_BUSY',
        errorCode: CallErrorCode.Busy,
      });
    }
  }

  private async lockParticipantsForCall(
    userIDs: string[],
    prisma: Pick<PrismaService, '$queryRaw'>,
  ): Promise<void> {
    for (const userID of [...userIDs].sort((a, b) => a.localeCompare(b))) {
      await prisma.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`call-user:${userID}`}, 0))
      `;
    }
  }

  private async expireStaleRingingCallsForUsers(
    userIDs: string[],
  ): Promise<void> {
    const now = new Date();
    const staleCalls = (await this.prisma.callSession.findMany({
      where: {
        status: CallStatus.RINGING,
        expiresAt: { lte: now },
        participants: {
          some: {
            userID: { in: userIDs },
            status: {
              in: [CallParticipantStatus.INVITED, CallParticipantStatus.JOINED],
            },
          },
        },
      },
      include: this.callInclude(),
      take: 20,
    })) as CallWithParticipants[];

    for (const call of staleCalls) {
      await this.expireRingingCallAsMissed(call, now);
    }
  }

  private async endRingingCallIfNoInviteesRemain(
    call: CallWithParticipants,
    changedAt: Date,
  ): Promise<void> {
    if (call.status !== CallStatus.RINGING) {
      return;
    }

    const remainingInvitees = await this.prisma.callParticipant.count({
      where: {
        callID: call.id,
        status: CallParticipantStatus.INVITED,
      },
    });
    if (remainingInvitees > 0) {
      return;
    }

    await this.expireRingingCallAsMissed(call, changedAt);
  }

  private async loadActiveUsers(
    userIDs: string[],
  ): Promise<Map<string, UserLite>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIDs }, status: UserStatus.ACTIVE },
      select: userLiteSelect,
    });
    if (users.length < userIDs.length) {
      throw new BadRequestException({
        message: 'CALL_INVITEE_INVALID',
        errorCode: CallErrorCode.InviteeInvalid,
      });
    }
    return new Map(users.map((user) => [user.id, user]));
  }

  private async findIdempotentCreateCall(
    initiatorID: string,
    idempotencyKey?: string,
  ): Promise<CallWithParticipants | null> {
    const key = idempotencyKey?.trim();
    if (!key) {
      return null;
    }
    return (await this.prisma.callSession.findFirst({
      where: {
        initiatorID,
        status: { in: [CallStatus.RINGING, CallStatus.ACTIVE] },
        metadata: {
          path: ['idempotencyKey'],
          equals: key,
        },
      },
      include: this.callInclude(),
    })) as CallWithParticipants | null;
  }

  private async mintToken(call: CallWithParticipants, user: UserLite) {
    if (!call.livekitRoomName || !call.callType) {
      throw new ServiceUnavailableException('LIVEKIT_UNAVAILABLE');
    }
    return this.livekit.mintJoinToken({
      identity: user.id,
      name: user.nickname,
      roomName: call.livekitRoomName,
      callType: call.callType as CallType,
      metadata: JSON.stringify({
        avatarUrl: user.avatarUrl,
      }),
    });
  }

  private async broadcastToCallParticipants(
    call: CallWithParticipants,
    broadcast: (userID: string) => void,
  ) {
    const userIDs = this.uniqueIDs(
      (call.participants ?? []).map((p) => p.userID),
    );
    await this.realtime.safeBroadcastAll(
      userIDs.map((targetID) => () => broadcast(targetID)),
    );
  }

  private async expireRingingCallAsMissed(
    call: CallWithParticipants,
    changedAt: Date,
  ): Promise<void> {
    const result = await this.prisma.callSession.updateMany({
      where: { id: call.id, status: CallStatus.RINGING },
      data: {
        status: CallStatus.MISSED,
        endReason: CallEndReason.NO_ANSWER,
        endedAt: changedAt,
      },
    });
    if (result.count === 0) {
      return;
    }

    await this.prisma.callParticipant.updateMany({
      where: {
        callID: call.id,
        status: CallParticipantStatus.INVITED,
      },
      data: {
        status: CallParticipantStatus.MISSED,
        missedAt: changedAt,
      },
    });

    if (call.livekitRoomName) {
      await this.livekit.deleteRoom(call.livekitRoomName);
    }

    await this.broadcastToCallParticipants(call, (targetID) =>
      this.realtime.broadcastCallEnded(targetID, {
        callId: call.id,
        status: CallStatus.MISSED,
        endReason: CallEndReason.NO_ANSWER,
        endedAt: changedAt.toISOString(),
        changedAt: changedAt.toISOString(),
      }),
    );
    this.logger.log(
      `call.missed callId=${call.id} reason=${CallEndReason.NO_ANSWER}`,
    );
    this.emitCallRecordMessage(call, CallEndReason.NO_ANSWER, changedAt);
  }

  private async failRingingCallAsError(
    call: CallWithParticipants,
    changedAt: Date,
  ): Promise<void> {
    const result = await this.prisma.callSession.updateMany({
      where: { id: call.id, status: CallStatus.RINGING },
      data: {
        status: CallStatus.FAILED,
        endReason: CallEndReason.ERROR,
        endedAt: changedAt,
      },
    });
    if (result.count === 0) {
      return;
    }

    if (call.livekitRoomName) {
      await this.livekit.deleteRoom(call.livekitRoomName);
    }

    await this.broadcastToCallParticipants(call, (targetID) =>
      this.realtime.broadcastCallEnded(targetID, {
        callId: call.id,
        status: CallStatus.FAILED,
        endReason: CallEndReason.ERROR,
        endedAt: changedAt.toISOString(),
        changedAt: changedAt.toISOString(),
      }),
    );
    this.logger.log(
      `call.failed callId=${call.id} reason=${CallEndReason.ERROR}`,
    );
    this.emitCallRecordMessage(call, CallEndReason.ERROR, changedAt);
  }

  private async endLiveKitFinishedCall(
    call: CallWithParticipants,
    changedAt: Date,
  ): Promise<void> {
    const result = await this.prisma.callSession.updateMany({
      where: {
        id: call.id,
        status: { in: [CallStatus.RINGING, CallStatus.ACTIVE] },
      },
      data: {
        status: CallStatus.ENDED,
        endReason: CallEndReason.NORMAL,
        endedAt: changedAt,
      },
    });
    if (result.count === 0) {
      return;
    }

    await this.prisma.callParticipant.updateMany({
      where: {
        callID: call.id,
        status: CallParticipantStatus.JOINED,
      },
      data: {
        status: CallParticipantStatus.LEFT,
        leftAt: changedAt,
      },
    });

    await this.broadcastToCallParticipants(call, (targetID) =>
      this.realtime.broadcastCallEnded(targetID, {
        callId: call.id,
        status: CallStatus.ENDED,
        endReason: CallEndReason.NORMAL,
        endedAt: changedAt.toISOString(),
        changedAt: changedAt.toISOString(),
      }),
    );
    this.logger.log(
      `call.ended callId=${call.id} reason=livekit_room_finished`,
    );
    this.emitCallRecordMessage(call, CallEndReason.NORMAL, changedAt);
  }

  /**
   * 通话留痕消息（#115）：五个终局路径统一在此落一条 contentType 110 的
   * 自定义消息进会话（data.type='call_record'），客户端渲染可点击的通话记录行。
   * fire-and-forget：留痕失败绝不能反过来阻断通话收尾（teardown 的
   * 广播/删房都在留痕之前完成）。只有未接（NO_ANSWER）带离线推送。
   */
  private emitCallRecordMessage(
    call: CallWithParticipants,
    endReason: CallEndReason,
    endedAt: Date,
  ): void {
    void (async () => {
      const initiator =
        call.initiator ??
        this.findParticipant(call, call.initiatorID ?? '')?.user;
      if (!call.initiatorID || !call.conversationID) return;

      const durationSeconds =
        call.startedAt != null
          ? Math.max(
              0,
              Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000),
            )
          : null;

      const isSingle = call.sessionType !== GROUP_SESSION_TYPE;
      let target:
        | { kind: 'single'; recvID: string }
        | { kind: 'group'; groupID: string };
      if (isSingle) {
        const other = call.participants?.find(
          (participant) => participant.userID !== call.initiatorID,
        );
        if (!other) return;
        target = { kind: 'single', recvID: other.userID };
      } else {
        target = {
          kind: 'group',
          groupID: this.rawOpenimGroupID(call.conversationID),
        };
      }

      await this.openimService.sendCallRecordMessage({
        sendID: call.initiatorID,
        senderNickname: initiator?.nickname,
        senderFaceURL: initiator?.avatarUrl ?? null,
        target,
        data: {
          type: 'call_record',
          callId: call.id,
          callType: call.callType ?? 'AUDIO',
          sessionType: isSingle ? 'single' : 'group',
          endReason,
          durationSeconds,
          initiatorID: call.initiatorID,
        },
        offlinePush:
          endReason === CallEndReason.NO_ANSWER
            ? {
                title: initiator?.nickname ?? 'Circle',
                desc:
                  call.callType === 'VIDEO'
                    ? '视频通话未接听'
                    : '语音通话未接听',
              }
            : null,
      });
    })().catch((error) => {
      this.logger.warn(
        `call record message failed callId=${call.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private buildTokenResponse(token: string) {
    return {
      url: this.livekit.getClientUrl(),
      token,
      expiresAt: this.dateAfterSeconds(this.tokenTtlSeconds()).toISOString(),
    };
  }

  private toCallDto(call: CallWithParticipants) {
    return {
      id: call.id,
      conversationID: call.conversationID,
      sessionType: call.sessionType === GROUP_SESSION_TYPE ? 'group' : 'single',
      callType: call.callType,
      status: call.status,
      livekitRoomName: call.livekitRoomName,
      initiator: call.initiator,
      startedAt: call.startedAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      expiresAt: call.expiresAt?.toISOString() ?? null,
      durationSeconds:
        call.startedAt && call.endedAt
          ? Math.max(
              0,
              Math.floor(
                (call.endedAt.getTime() - call.startedAt.getTime()) / 1000,
              ),
            )
          : null,
      endReason: call.endReason ?? null,
      participants: (call.participants ?? []).map((participant) =>
        this.toParticipantDto(participant),
      ),
    };
  }

  private toParticipantDto(participant: CallParticipantWithUser | undefined) {
    if (!participant) {
      return null;
    }
    return {
      user: participant.user,
      status: participant.status,
      invitedAt: participant.invitedAt?.toISOString() ?? null,
      joinedAt: participant.joinedAt?.toISOString() ?? null,
      leftAt: participant.leftAt?.toISOString() ?? null,
    };
  }

  private findParticipant(call: CallWithParticipants, userID: string) {
    return call.participants?.find(
      (participant) => participant.userID === userID,
    );
  }

  private callInclude() {
    return {
      initiator: { select: userLiteSelect },
      participants: {
        include: { user: { select: userLiteSelect } },
        orderBy: { invitedAt: 'asc' as const },
      },
    };
  }

  private assertCallTypeEnabled(callType: CallType): void {
    if (callType === CallType.VIDEO && !this.readBoolean('CALL_ENABLE_VIDEO')) {
      throw new BadRequestException({
        message: 'CALL_VIDEO_DISABLED',
        errorCode: CallErrorCode.VideoDisabled,
      });
    }
  }

  private assertParticipantLimit(totalParticipants: number): void {
    if (totalParticipants > this.maxParticipants()) {
      throw new BadRequestException({
        message: 'CALL_PARTICIPANT_LIMIT',
        errorCode: CallErrorCode.ParticipantLimit,
      });
    }
  }

  private maxParticipants(): number {
    return this.readPositiveInt('CALL_MAX_PARTICIPANTS', 10);
  }

  private ringTimeoutSeconds(): number {
    return this.readPositiveInt('CALL_RING_TIMEOUT_SECONDS', 45);
  }

  private tokenTtlSeconds(): number {
    return this.readPositiveInt('LIVEKIT_TOKEN_TTL_SECONDS', 3600);
  }

  private readPositiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<number | string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private readBoolean(key: string): boolean {
    return this.config.get<boolean | string>(key) === true;
  }

  private dateAfterSeconds(seconds: number): Date {
    return new Date(Date.now() + seconds * 1000);
  }

  private normalizeID(value: string, message: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new NotFoundException(message);
    }
    return normalized;
  }

  private uniqueIDs(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  }

  private rawOpenimGroupID(groupID: string): string {
    return groupID.startsWith('sg_') ? groupID.slice(3) : groupID;
  }

  private groupIDCandidates(groupID: string): string[] {
    return Array.from(
      new Set([
        groupID,
        groupID.startsWith('sg_') ? groupID.slice(3) : groupID,
      ]),
    );
  }
}
