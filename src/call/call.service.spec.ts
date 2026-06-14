import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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
      $queryRaw: jest.fn().mockResolvedValue([]),
      circle: { findFirst: jest.fn() },
      circleMember: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
      callSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
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
    prisma.callSession.findMany.mockResolvedValue([]);
    livekit = {
      createRoom: jest.fn().mockResolvedValue(undefined),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
      getClientUrl: jest.fn().mockReturnValue('wss://livekit.example.com'),
      mintJoinToken: jest.fn().mockResolvedValue('livekit-token'),
    };
    realtime = {
      broadcastCallInvite: jest.fn(),
      broadcastCallParticipantJoined: jest.fn(),
      broadcastCallParticipantLeft: jest.fn(),
      broadcastCallParticipantRejected: jest.fn(),
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
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('returns an existing call for a repeated create idempotency key', async () => {
    mockCircleMembers();
    prisma.callSession.findFirst.mockResolvedValue({
      id: 'call-1',
      conversationID: 'sg_group-1',
      sessionType: 3,
      callType: 'AUDIO',
      status: 'RINGING',
      livekitRoomName: 'circle_call_1',
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      startedAt: null,
      endedAt: null,
      expiresAt: new Date('2026-06-11T03:00:45.000Z'),
      endReason: null,
      participants: [
        {
          userID: 'user-1',
          status: 'JOINED',
          invitedAt: now,
          joinedAt: now,
          leftAt: null,
          user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        },
        {
          userID: 'user-2',
          status: 'INVITED',
          invitedAt: now,
          joinedAt: null,
          leftAt: null,
          user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        },
      ],
    });

    const result = await service.createGroupCall(
      'user-1',
      {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      },
      'request-1',
    );

    expect(result.call.id).toBe('call-1');
    expect(livekit.createRoom).not.toHaveBeenCalled();
    expect(prisma.callSession.create).not.toHaveBeenCalled();
    expect(livekit.mintJoinToken).toHaveBeenCalledWith(
      expect.objectContaining({ roomName: 'circle_call_1' }),
    );
  });

  it('deletes the LiveKit room when call persistence fails after room creation', async () => {
    mockCircleMembers();
    prisma.callSession.create.mockRejectedValue(new Error('db down'));

    await expect(
      service.createGroupCall('user-1', {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      }),
    ).rejects.toThrow('db down');

    expect(livekit.createRoom).toHaveBeenCalled();
    expect(livekit.deleteRoom).toHaveBeenCalledWith(
      expect.stringMatching(/^circle_call_/),
    );
  });

  it('marks the call failed and deletes the room when token minting fails', async () => {
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
            user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
          },
          {
            userID: 'user-2',
            status: 'INVITED',
            invitedAt: now,
            joinedAt: null,
            leftAt: null,
            user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
          },
        ],
      }),
    );
    livekit.mintJoinToken.mockRejectedValue(new Error('livekit down'));
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.createGroupCall('user-1', {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      }),
    ).rejects.toThrow('livekit down');

    expect(prisma.callSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RINGING',
        }),
        data: expect.objectContaining({
          status: 'FAILED',
          endReason: 'ERROR',
        }),
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith(
      expect.stringMatching(/^circle_call_/),
    );
    expect(realtime.broadcastCallInvite).not.toHaveBeenCalled();
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

  it('expires stale ringing calls before checking whether participants are busy', async () => {
    mockCircleMembers();
    let staleCallExpired = false;
    prisma.callSession.findMany.mockResolvedValue([
      {
        id: 'stale-call',
        livekitRoomName: 'circle_call_stale',
        status: 'RINGING',
        participants: [{ userID: 'user-1' }, { userID: 'user-2' }],
      },
    ]);
    prisma.callSession.updateMany.mockImplementation(() => {
      staleCallExpired = true;
      return Promise.resolve({ count: 1 });
    });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.findFirst.mockImplementation(() =>
      Promise.resolve(staleCallExpired ? null : { id: 'stale-participant' }),
    );
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
            user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
          },
          {
            userID: 'user-2',
            status: 'INVITED',
            invitedAt: now,
            joinedAt: null,
            leftAt: null,
            user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
          },
        ],
      }),
    );

    await service.createGroupCall('user-1', {
      conversationID: 'group-1',
      callType: 'AUDIO',
      inviteeIDs: ['user-2'],
    });

    expect(prisma.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'RINGING',
          expiresAt: { lte: now },
        }),
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_stale');
    expect(prisma.callParticipant.findFirst).toHaveBeenCalled();
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

  it('treats repeated accept as idempotent when the participant already joined', async () => {
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: 'JOINED',
      invitedAt: now,
      joinedAt: now,
      leftAt: null,
      call: {
        id: 'call-1',
        conversationID: 'sg_group-1',
        sessionType: 3,
        callType: 'AUDIO',
        status: 'ACTIVE',
        livekitRoomName: 'circle_call_1',
        participants: [],
      },
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });

    const result = await service.acceptCall('user-2', 'call-1');

    expect(prisma.callParticipant.update).not.toHaveBeenCalled();
    expect(result.selfParticipant?.status).toBe('JOINED');
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

  it('requires invited participants to accept before minting a join token', async () => {
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
        expiresAt: new Date('2026-06-11T03:00:45.000Z'),
        participants: [],
      },
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });

    await expect(service.createJoinToken('user-2', 'call-1')).rejects.toThrow(
      ConflictException,
    );

    expect(prisma.callParticipant.update).not.toHaveBeenCalled();
    expect(livekit.mintJoinToken).not.toHaveBeenCalled();
  });

  it('expires stale ringing calls before minting another token', async () => {
    jest.setSystemTime(new Date('2026-06-11T03:01:00.000Z').getTime());
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-1',
      status: 'JOINED',
      call: {
        id: 'call-1',
        conversationID: 'sg_group-1',
        sessionType: 3,
        callType: 'AUDIO',
        status: 'RINGING',
        livekitRoomName: 'circle_call_1',
        expiresAt: new Date('2026-06-11T03:00:45.000Z'),
        participants: [{ userID: 'user-1' }, { userID: 'user-2' }],
      },
      user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
    });
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.createJoinToken('user-1', 'call-1')).rejects.toThrow(
      ConflictException,
    );

    expect(prisma.callSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1', status: 'RINGING' },
        data: expect.objectContaining({
          status: 'MISSED',
          endReason: 'NO_ANSWER',
        }),
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_1');
    expect(livekit.mintJoinToken).not.toHaveBeenCalled();
  });

  it('broadcasts when an invited participant rejects', async () => {
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: 'INVITED',
      call: {
        id: 'call-1',
        status: 'RINGING',
        participants: [
          { userID: 'user-1' },
          { userID: 'user-2' },
        ],
      },
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.update.mockResolvedValue({
      userID: 'user-2',
      status: 'REJECTED',
      invitedAt: now,
      joinedAt: null,
      leftAt: null,
      rejectedAt: now,
      missedAt: null,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.count.mockResolvedValue(1);

    await service.rejectCall('user-2', 'call-1');

    expect(realtime.broadcastCallParticipantRejected).toHaveBeenCalledTimes(2);
    expect(realtime.broadcastCallParticipantRejected).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        callId: 'call-1',
        user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        rejectedAt: now.toISOString(),
      }),
    );
  });

  it('treats repeated reject as idempotent when the participant already rejected', async () => {
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: 'REJECTED',
      invitedAt: now,
      joinedAt: null,
      leftAt: null,
      rejectedAt: now,
      call: {
        id: 'call-1',
        status: 'RINGING',
        participants: [],
      },
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });

    const result = await service.rejectCall('user-2', 'call-1');

    expect(prisma.callParticipant.update).not.toHaveBeenCalled();
    expect(result.status).toBe('REJECTED');
  });

  it('marks a ringing call missed when the last invitee rejects', async () => {
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: 'INVITED',
      call: {
        id: 'call-1',
        livekitRoomName: 'circle_call_1',
        status: 'RINGING',
        participants: [
          { userID: 'user-1' },
          { userID: 'user-2' },
        ],
      },
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.update.mockResolvedValue({
      userID: 'user-2',
      status: 'REJECTED',
      invitedAt: now,
      joinedAt: null,
      leftAt: null,
      rejectedAt: now,
      missedAt: null,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.count.mockResolvedValue(0);
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callSession.findUnique.mockResolvedValue({
      id: 'call-1',
      livekitRoomName: 'circle_call_1',
      status: 'MISSED',
      endReason: 'NO_ANSWER',
      endedAt: now,
      participants: [
        { userID: 'user-1' },
        { userID: 'user-2' },
      ],
    });

    await service.rejectCall('user-2', 'call-1');

    expect(prisma.callSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1', status: 'RINGING' },
        data: expect.objectContaining({
          status: 'MISSED',
          endReason: 'NO_ANSWER',
        }),
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_1');
    expect(realtime.broadcastCallEnded).toHaveBeenCalledTimes(2);
  });

  it('broadcasts when a joined participant leaves and the call remains active', async () => {
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
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.update.mockResolvedValue({
      userID: 'user-2',
      status: 'LEFT',
      invitedAt: now,
      joinedAt: now,
      leftAt: now,
      rejectedAt: null,
      missedAt: null,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.count.mockResolvedValue(1);

    await service.leaveCall('user-2', 'call-1');

    expect(realtime.broadcastCallParticipantLeft).toHaveBeenCalledTimes(2);
    expect(prisma.callSession.update).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it('treats repeated cancel as idempotent when already canceled by initiator', async () => {
    prisma.callSession.findUnique.mockResolvedValue({
      id: 'call-1',
      conversationID: 'sg_group-1',
      sessionType: 3,
      callType: 'AUDIO',
      status: 'CANCELED',
      livekitRoomName: 'circle_call_1',
      initiatorID: 'user-1',
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      startedAt: null,
      endedAt: now,
      expiresAt: new Date('2026-06-11T03:00:45.000Z'),
      endReason: 'CANCELED',
      participants: [],
    });

    const result = await service.cancelCall('user-1', 'call-1');

    expect(prisma.callParticipant.updateMany).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
    expect(result.status).toBe('CANCELED');
  });

  it('sweeps expired ringing calls in batches', async () => {
    prisma.callSession.findMany.mockResolvedValue([
      {
        id: 'call-1',
        livekitRoomName: 'circle_call_1',
        status: 'RINGING',
        participants: [{ userID: 'user-1' }, { userID: 'user-2' }],
      },
      {
        id: 'call-2',
        livekitRoomName: 'circle_call_2',
        status: 'RINGING',
        participants: [{ userID: 'user-3' }],
      },
    ]);
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });

    await expect((service as any).sweepExpiredRingingCalls(10)).resolves.toBe(2);

    expect(prisma.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'RINGING', expiresAt: { lte: now } },
        take: 10,
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_1');
    expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_2');
  });

  it('marks LiveKit room_finished webhooks as ended', async () => {
    prisma.callSession.findUnique.mockResolvedValue({
      id: 'call-1',
      livekitRoomName: 'circle_call_1',
      status: 'ACTIVE',
      participants: [{ userID: 'user-1' }, { userID: 'user-2' }],
    });
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });

    await service.handleLiveKitWebhook({
      event: 'room_finished',
      room: { name: 'circle_call_1' },
    });

    expect(prisma.callSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1', status: { in: ['RINGING', 'ACTIVE'] } },
        data: expect.objectContaining({
          status: 'ENDED',
          endReason: 'NORMAL',
        }),
      }),
    );
    expect(realtime.broadcastCallEnded).toHaveBeenCalledTimes(2);
  });
});
