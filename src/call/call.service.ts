import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  CallEndReason,
  CallParticipantStatus,
  CallStatus,
  CallType,
  CircleMemberStatus,
  Prisma,
  UserStatus,
} from 'src/generated/prisma';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CreateGroupCallDto } from './dto/call.dto';
import { LiveKitCallService } from './livekit.service';

const GROUP_SESSION_TYPE = 3;

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

const userLiteSelect = {
  id: true,
  nickname: true,
  avatarUrl: true,
};

@Injectable()
export class CallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openimService: OpenimService,
    private readonly livekit: LiveKitCallService,
    private readonly realtime: RealtimeService,
    private readonly config: ConfigService,
  ) {}

  async createGroupCall(initiatorID: string, dto: CreateGroupCallDto) {
    const conversationID = this.normalizeID(dto.conversationID, 'Group not found');
    const inviteeIDs = this.uniqueIDs(dto.inviteeIDs).filter(
      (userID) => userID !== initiatorID,
    );
    if (inviteeIDs.length === 0) {
      throw new BadRequestException('CALL_INVITEES_REQUIRED');
    }
    this.assertCallTypeEnabled(dto.callType);

    const participantIDs = [initiatorID, ...inviteeIDs];
    this.assertParticipantLimit(participantIDs.length);

    await this.assertGroupMembers(conversationID, participantIDs, initiatorID);
    const users = await this.loadActiveUsers(participantIDs);
    await this.expireStaleRingingCallsForUsers(participantIDs);
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
          await this.assertNotBusy(participantIDs, tx);
          return tx.callSession.create({
            data: {
              id: callId,
              conversationID,
              sessionType: GROUP_SESSION_TYPE,
              callType: dto.callType,
              status: CallStatus.RINGING,
              livekitRoomName,
              initiatorID,
              expiresAt,
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
      sessionType: 'group' as const,
      callType: dto.callType,
      initiator: users.get(initiatorID)!,
      invitees: inviteeIDs.map((id) => users.get(id)!),
      expiresAt: expiresAt.toISOString(),
      createdAt: (call.createdAt ?? joinedAt).toISOString(),
    };

    await this.realtime.safeBroadcastAll(
      inviteeIDs.map((userID) => () =>
        this.realtime.broadcastCallInvite(userID, invitePayload),
      ),
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
    if (participant.status !== CallParticipantStatus.INVITED) {
      throw new ConflictException('CALL_NOT_INVITED');
    }

    const call = participant.call as CallWithParticipants;
    if (call.status !== CallStatus.RINGING && call.status !== CallStatus.ACTIVE) {
      throw new ConflictException('CALL_ENDED');
    }
    if (call.expiresAt && call.expiresAt.getTime() < Date.now()) {
      await this.expireRingingCallAsMissed(call, new Date());
      throw new ConflictException('CALL_EXPIRED');
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

    return {
      call: this.toCallDto(updatedCall as CallWithParticipants),
      selfParticipant: this.toParticipantDto(updatedParticipant),
      livekit: this.buildTokenResponse(token),
    };
  }

  async rejectCall(userID: string, callId: string) {
    const participant = await this.findParticipantForUser(callId, userID);
    if (participant.status !== CallParticipantStatus.INVITED) {
      throw new ConflictException('CALL_NOT_INVITED');
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
  }

  async cancelCall(userID: string, callId: string) {
    const call = (await this.prisma.callSession.findUnique({
      where: { id: callId },
      include: this.callInclude(),
    })) as CallWithParticipants | null;
    if (!call) {
      throw new NotFoundException('CALL_NOT_FOUND');
    }
    if (call.initiatorID !== userID) {
      throw new ForbiddenException('CALL_NOT_ALLOWED');
    }
    if (call.status !== CallStatus.RINGING) {
      throw new ConflictException('CALL_ALREADY_ACTIVE');
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
    return this.toCallDto(canceled);
  }

  async createJoinToken(userID: string, callId: string) {
    const participant = await this.findParticipantForUser(callId, userID);
    const call = participant.call as CallWithParticipants;
    if (call.status !== CallStatus.RINGING && call.status !== CallStatus.ACTIVE) {
      throw new ConflictException('CALL_ENDED');
    }
    if (
      call.status === CallStatus.RINGING &&
      call.expiresAt &&
      call.expiresAt.getTime() < Date.now()
    ) {
      await this.expireRingingCallAsMissed(call, new Date());
      throw new ConflictException('CALL_EXPIRED');
    }
    if (participant.status !== CallParticipantStatus.JOINED) {
      throw new ConflictException('CALL_NOT_ACCEPTED');
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
      throw new NotFoundException('CALL_NOT_FOUND');
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
        throw new ForbiddenException('CALL_NOT_GROUP_MEMBER');
      }
      if (!participantIDs.every((userID) => active.has(userID))) {
        throw new BadRequestException('CALL_INVITEE_INVALID');
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
        throw new ForbiddenException('CALL_NOT_GROUP_MEMBER');
      }
      if (checks.some((isMember) => !isMember)) {
        throw new BadRequestException('CALL_INVITEE_INVALID');
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
      throw new ConflictException('CALL_BUSY');
    }
  }

  private async expireStaleRingingCallsForUsers(userIDs: string[]): Promise<void> {
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

  private async loadActiveUsers(userIDs: string[]): Promise<Map<string, UserLite>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIDs }, status: UserStatus.ACTIVE },
      select: userLiteSelect,
    });
    if (users.length < userIDs.length) {
      throw new BadRequestException('CALL_INVITEE_INVALID');
    }
    return new Map(users.map((user) => [user.id, user]));
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
    const userIDs = this.uniqueIDs((call.participants ?? []).map((p) => p.userID));
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
              Math.floor((call.endedAt.getTime() - call.startedAt.getTime()) / 1000),
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
    return call.participants?.find((participant) => participant.userID === userID);
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
      throw new BadRequestException('CALL_VIDEO_DISABLED');
    }
  }

  private assertParticipantLimit(totalParticipants: number): void {
    if (totalParticipants > this.maxParticipants()) {
      throw new BadRequestException('CALL_PARTICIPANT_LIMIT');
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
