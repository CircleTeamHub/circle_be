import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircleMemberStatus } from 'src/generated/prisma';
import { CallService } from './call.service';

describe('CallService', () => {
  const now = new Date('2026-06-11T03:00:00.000Z');
  let prisma: any;
  let openim: any;
  let livekit: any;
  let realtime: any;
  let service: CallService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());

    prisma = {
      $transaction: jest.fn(async (callback) => callback(prisma)),
      circle: { findFirst: jest.fn() },
      circleMember: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
      callSession: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      callParticipant: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    openim = { isGroupMember: jest.fn() };
    livekit = {
      createRoom: jest.fn().mockResolvedValue(undefined),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
      getClientUrl: jest.fn().mockReturnValue('wss://livekit.example.com'),
      mintJoinToken: jest.fn().mockResolvedValue('livekit-token'),
    };
    realtime = {
      broadcastCallInvite: jest.fn(),
      broadcastCallParticipantJoined: jest.fn(),
      broadcastCallEnded: jest.fn(),
      safeBroadcastAll: jest.fn(async (callbacks: Array<() => unknown>) => {
        for (const callback of callbacks) {
          await callback();
        }
      }),
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'CALL_MAX_PARTICIPANTS') return 10;
        if (key === 'CALL_RING_TIMEOUT_SECONDS') return 45;
        if (key === 'CALL_ENABLE_VIDEO') return false;
        return undefined;
      }),
    } as unknown as ConfigService;

    service = new CallService(
      prisma,
      openim,
      livekit,
      realtime,
      config,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockCircleMembers() {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'user-1',
    });
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'user-1', status: CircleMemberStatus.ACTIVE },
      { userID: 'user-2', status: CircleMemberStatus.ACTIVE },
      { userID: 'user-3', status: CircleMemberStatus.ACTIVE },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'user-1', nickname: 'Alice', avatarUrl: null, status: 'ACTIVE' },
      { id: 'user-2', nickname: 'Bob', avatarUrl: null, status: 'ACTIVE' },
      { id: 'user-3', nickname: 'Cara', avatarUrl: null, status: 'ACTIVE' },
    ]);
    prisma.callParticipant.findFirst.mockResolvedValue(null);
  }

  it('creates a group audio call for active mapped group members', async () => {
    mockCircleMembers();
    prisma.callSession.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        ...data,
        createdAt: now,
        updatedAt: now,
        initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        participants: [
          {
            userID: 'user-1',
            status: 'JOINED',
            invitedAt: now,
            joinedAt: now,
            leftAt: null,
            rejectedAt: null,
            missedAt: null,
            user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
          },
          {
            userID: 'user-2',
            status: 'INVITED',
            invitedAt: now,
            joinedAt: null,
            leftAt: null,
            rejectedAt: null,
            missedAt: null,
            user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
          },
        ],
      }),
    );

    const result = await service.createGroupCall('user-1', {
      conversationID: 'sg_group-1',
      callType: 'AUDIO',
      inviteeIDs: ['user-2', 'user-2', 'user-1', ' '],
    });

    expect(livekit.createRoom).toHaveBeenCalledWith({
      name: expect.stringMatching(/^circle_call_/),
      maxParticipants: 10,
      metadata: expect.stringContaining('callId'),
    });
    expect(prisma.callSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationID: 'sg_group-1',
          callType: 'AUDIO',
          status: 'RINGING',
          initiatorID: 'user-1',
          participants: {
            create: expect.arrayContaining([
              expect.objectContaining({ userID: 'user-1', status: 'JOINED' }),
              expect.objectContaining({ userID: 'user-2', status: 'INVITED' }),
            ]),
          },
        }),
      }),
    );
    expect(livekit.mintJoinToken).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: 'user-1',
        roomName: expect.stringMatching(/^circle_call_/),
        callType: 'AUDIO',
      }),
    );
    expect(realtime.broadcastCallInvite).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({
        callId: result.call.id,
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
      }),
    );
    expect(result.livekit).toEqual({
      url: 'wss://livekit.example.com',
      token: 'livekit-token',
      expiresAt: '2026-06-11T04:00:00.000Z',
    });
  });

  it('rejects group calls without invitees', async () => {
    await expect(
      service.createGroupCall('user-1', {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-1', '  '],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(livekit.createRoom).not.toHaveBeenCalled();
  });

  it('rejects calls when the initiator is not an active mapped group member', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'user-2', status: CircleMemberStatus.ACTIVE },
    ]);

    await expect(
      service.createGroupCall('user-1', {
        conversationID: 'group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('accepts an invited participant and returns their LiveKit token', async () => {
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: 'INVITED',
      call: {
        id: 'call-1',
        conversationID: 'sg_group-1',
        sessionType: 3,
        callType: 'AUDIO',
        status: 'RINGING',
        livekitRoomName: 'circle_call_1',
        initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        participants: [
          { userID: 'user-1', user: { id: 'user-1', nickname: 'Alice', avatarUrl: null } },
          { userID: 'user-2', user: { id: 'user-2', nickname: 'Bob', avatarUrl: null } },
        ],
      },
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.update.mockResolvedValue({
      userID: 'user-2',
      status: 'JOINED',
      invitedAt: now,
      joinedAt: now,
      leftAt: null,
      rejectedAt: null,
      missedAt: null,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callSession.update.mockResolvedValue({
      id: 'call-1',
      conversationID: 'sg_group-1',
      sessionType: 3,
      callType: 'AUDIO',
      status: 'ACTIVE',
      livekitRoomName: 'circle_call_1',
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      participants: [],
      startedAt: now,
      endedAt: null,
      expiresAt: new Date('2026-06-11T03:00:45.000Z'),
      endReason: null,
    });

    const result = await service.acceptCall('user-2', 'call-1');

    expect(prisma.callParticipant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'JOINED', joinedAt: now }),
      }),
    );
    expect(livekit.mintJoinToken).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: 'user-2',
        roomName: 'circle_call_1',
      }),
    );
    expect(realtime.broadcastCallParticipantJoined).toHaveBeenCalled();
    expect(result.livekit.token).toBe('livekit-token');
  });

  it('ends the call when the last joined participant leaves', async () => {
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: 'JOINED',
      call: {
        id: 'call-1',
        livekitRoomName: 'circle_call_1',
        status: 'ACTIVE',
        participants: [
          { userID: 'user-1' },
          { userID: 'user-2' },
        ],
      },
    });
    prisma.callParticipant.update.mockResolvedValue({});
    prisma.callParticipant.count.mockResolvedValue(0);
    prisma.callSession.update.mockResolvedValue({
      id: 'call-1',
      status: 'ENDED',
      endReason: 'ALL_LEFT',
      endedAt: now,
      participants: [
        { userID: 'user-1' },
        { userID: 'user-2' },
      ],
    });

    await service.leaveCall('user-2', 'call-1');

    expect(prisma.callSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({
          status: 'ENDED',
          endReason: 'ALL_LEFT',
          endedAt: now,
        }),
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_1');
    expect(realtime.broadcastCallEnded).toHaveBeenCalledTimes(2);
  });
});
