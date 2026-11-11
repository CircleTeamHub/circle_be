import { ConfigService } from '@nestjs/config';
import { CallService } from './call.service';

describe('in-progress call invitations', () => {
  const now = new Date('2026-11-10T18:00:00Z');
  const user = (id: string) => ({ id, nickname: id, avatarUrl: null });
  let call: any;
  let prisma: any;
  let realtime: any;
  let livekit: any;
  let push: any;
  let service: CallService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());
    call = {
      id: 'call-1',
      conversationID: 'group-1',
      sessionType: 3,
      callType: 'AUDIO',
      status: 'ACTIVE',
      initiatorID: 'alice',
      initiator: user('alice'),
      livekitRoomName: 'room-1',
      metadata: {},
      expiresAt: new Date(now.getTime() - 60_000),
      createdAt: new Date(now.getTime() - 120_000),
      participants: ['alice', 'bob'].map((id) => ({
        userID: id,
        user: user(id),
        status: 'JOINED',
        invitedAt: new Date(now.getTime() - 120_000),
      })),
    };
    prisma = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockImplementation(async () => [{ id: call.id }]),
      $transaction: jest.fn(async (run: any) => run(prisma)),
      circle: { findFirst: jest.fn().mockResolvedValue(null) },
      chatConversation: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ type: 'GROUP', circleID: null }),
      },
      chatMember: {
        findMany: jest.fn().mockResolvedValue(
          ['alice', 'bob', 'carol'].map((userID) => ({
            userID,
            leftAt: null,
          })),
        ),
      },
      friend: {
        findFirst: jest.fn().mockResolvedValue({ id: 'friend' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      block: { findFirst: jest.fn().mockResolvedValue(null) },
      user: {
        findMany: jest.fn(async ({ where }: any) => where.id.in.map(user)),
      },
      callSession: {
        findUnique: jest.fn(async () => call),
        findFirst: jest.fn(async () => call),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(async ({ data }: any) => Object.assign(call, data)),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      callParticipant: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(async ({ where }: any) => {
          const participant = call.participants.find(
            (row: any) => row.userID === where.callID_userID.userID,
          );
          return participant ? { ...participant, call } : null;
        }),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          let participant = call.participants.find(
            (row: any) => row.userID === where.callID_userID.userID,
          );
          if (participant) Object.assign(participant, update);
          else {
            participant = { ...create, user: user(create.userID) };
            call.participants.push(participant);
          }
          return participant;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const rows = call.participants.filter(
            (row: any) =>
              row.userID === where.userID &&
              row.status === where.status &&
              (!(where.invitedAt instanceof Date) ||
                row.invitedAt?.getTime() === where.invitedAt.getTime()),
          );
          rows.forEach((row: any) => Object.assign(row, data));
          return { count: rows.length };
        }),
      },
    };
    realtime = {
      safeBroadcastAll: jest.fn(async (callbacks: any[]) => {
        for (const callback of callbacks) await callback();
      }),
      broadcastCallInvite: jest.fn(),
      broadcastCallUpdated: jest.fn(),
      broadcastCallParticipantJoined: jest.fn(),
      broadcastCallParticipantRejected: jest.fn(),
    };
    livekit = {
      updateRoomMetadata: jest.fn().mockResolvedValue(undefined),
      mintJoinToken: jest.fn().mockResolvedValue('token'),
      getClientUrl: () => 'wss://livekit.test',
    };
    push = { ringInvitees: jest.fn(), dismissForUser: jest.fn() };
    service = new CallService(
      prisma,
      {} as any,
      {} as any,
      livekit,
      realtime,
      {
        get: (key: string) =>
          ({ CALL_MAX_PARTICIPANTS: 10, CALL_RING_TIMEOUT_SECONDS: 45 })[key],
      } as ConfigService,
      {
        getSettingsForUsers: async () => new Map(),
        canBeCalled: async () => true,
      } as any,
      push,
    );
  });
  afterEach(() => jest.useRealTimers());

  const invite = (ids = ['carol']) =>
    (service as any).inviteParticipants('alice', 'call-1', { inviteeIDs: ids });

  it('adds a group member to the existing room with a fresh invitation deadline', async () => {
    const result = await invite();
    expect(result.call.id).toBe('call-1');
    expect(
      result.call.participants.find((row: any) => row.user.id === 'carol'),
    ).toMatchObject({
      status: 'INVITED',
      invitationExpiresAt: '2026-11-10T18:00:45.000Z',
    });
    expect(realtime.broadcastCallInvite).toHaveBeenCalledWith(
      'carol',
      expect.objectContaining({
        callId: 'call-1',
        expiresAt: '2026-11-10T18:00:45.000Z',
      }),
    );
    expect(push.ringInvitees).toHaveBeenCalledTimes(1);
  });

  it('does not ring participants who are already invited', async () => {
    await invite();
    await invite();
    expect(prisma.callParticipant.upsert).toHaveBeenCalledTimes(1);
    expect(push.ringInvitees).toHaveBeenCalledTimes(1);
  });

  it.each(['LEFT', 'REJECTED', 'MISSED'])(
    'allows an intentional new invitation after %s',
    async (status) => {
      call.participants.push({
        userID: 'carol',
        user: user('carol'),
        status,
        invitedAt: new Date(0),
        leftAt: now,
        rejectedAt: now,
        missedAt: now,
      });
      await invite();
      expect(call.participants.at(-1)).toMatchObject({
        status: 'INVITED',
        invitedAt: now,
        leftAt: null,
        rejectedAt: null,
        missedAt: null,
      });
    },
  );

  it('rejects an actor who has not joined', async () => {
    call.participants[0].status = 'INVITED';
    await expect(invite()).rejects.toMatchObject({
      response: { errorCode: 'CALL_NOT_ACCEPTED' },
    });
    expect(prisma.callParticipant.upsert).not.toHaveBeenCalled();
  });

  it('rejects a target who is outside the group', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'alice', leftAt: null },
    ]);
    await expect(invite()).rejects.toMatchObject({
      response: { errorCode: 'CALL_INVITEE_INVALID' },
    });
    expect(push.ringInvitees).not.toHaveBeenCalled();
  });

  it('rejects a busy target before sending any invitation', async () => {
    prisma.callParticipant.findFirst.mockResolvedValue({ id: 'busy' });
    await expect(invite()).rejects.toMatchObject({
      response: { errorCode: 'CALL_BUSY' },
    });
    expect(push.ringInvitees).not.toHaveBeenCalled();
  });

  it('promotes a direct call while removing its private identifier from room metadata and public data', async () => {
    call.sessionType = 1;
    call.conversationID = 'direct:alice:bob';
    const result = await invite();
    expect(livekit.updateRoomMetadata).toHaveBeenCalledWith(
      'room-1',
      JSON.stringify({ callId: 'call-1', conversationID: 'conference:call-1' }),
    );
    expect(result.call).toMatchObject({
      sessionType: 'group',
      invitationMode: 'contacts',
      conversationID: 'conference:call-1',
    });
    expect(JSON.stringify(result)).not.toContain('direct:alice:bob');
    expect(realtime.broadcastCallUpdated).toHaveBeenCalledWith('bob', {
      call: result.call,
    });
  });

  it('requires an accepted friendship when promoting a direct call', async () => {
    call.sessionType = 1;
    prisma.friend.findFirst.mockResolvedValue(null);
    await expect(invite()).rejects.toMatchObject({
      response: { errorCode: 'CALL_NOT_FRIEND' },
    });
    expect(push.ringInvitees).not.toHaveBeenCalled();
  });

  it('rejects a new contact blocked by an existing participant', async () => {
    call.sessionType = 1;
    prisma.block.findFirst.mockResolvedValue({ id: 'blocked' });
    await expect(invite()).rejects.toMatchObject({
      response: { errorCode: 'CALL_NOT_FRIEND' },
    });
    expect(push.ringInvitees).not.toHaveBeenCalled();
  });

  it('accepts a fresh invitation after the original ringing deadline', async () => {
    await invite();
    const result = await service.acceptCall('carol', 'call-1');
    expect(result.selfParticipant.status).toBe('JOINED');
    expect(livekit.mintJoinToken).toHaveBeenCalled();
  });

  it('does not disclose later participant joins to a rejected conference invitee', async () => {
    call.sessionType = 4;
    call.conversationID = 'conference:call-1';
    call.metadata = { invitedBy: { dave: 'alice' } };
    call.participants.push(
      {
        userID: 'carol',
        user: user('carol'),
        status: 'REJECTED',
        invitedAt: new Date(now.getTime() - 60_000),
        rejectedAt: new Date(now.getTime() - 30_000),
      },
      {
        userID: 'dave',
        user: user('dave'),
        status: 'INVITED',
        invitedAt: now,
      },
    );

    await service.acceptCall('dave', 'call-1', now);

    expect(realtime.broadcastCallParticipantJoined).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({ user: user('dave') }),
    );
    expect(realtime.broadcastCallParticipantJoined).toHaveBeenCalledWith(
      'dave',
      expect.objectContaining({ user: user('dave') }),
    );
    expect(realtime.broadcastCallParticipantJoined).not.toHaveBeenCalledWith(
      'carol',
      expect.anything(),
    );
  });

  it('expires an unanswered late invite while leaving the active room running', async () => {
    await invite();
    jest.setSystemTime(now.getTime() + 46_000);
    prisma.callSession.findMany.mockResolvedValue([call]);
    await service.sweepExpiredRingingCalls();
    expect(call.status).toBe('ACTIVE');
    expect(call.participants.at(-1).status).toBe('MISSED');
    expect(push.dismissForUser).toHaveBeenCalledWith(
      'call-1',
      'carol',
      'missed',
      now,
    );
    expect(prisma.callSession.updateMany).not.toHaveBeenCalled();
  });

  it('limits the active roster even when adding to a direct call', async () => {
    call.sessionType = 1;
    call.participants.push(
      ...Array.from({ length: 8 }, (_, index) => ({
        userID: `member-${index}`,
        status: 'JOINED',
        user: user(`member-${index}`),
      })),
    );
    await expect(invite()).rejects.toMatchObject({
      response: { errorCode: 'CALL_PARTICIPANT_LIMIT' },
    });
    expect(prisma.callParticipant.upsert).not.toHaveBeenCalled();
  });

  it('restores an invited conference contact with their own inviter and deadline', async () => {
    call.sessionType = 1;
    call.createdAt = new Date(now.getTime() - 120_000);
    await invite();
    call.initiator = user('bob');
    const result = await service.getCurrentCall('carol');
    expect(result.call).toMatchObject({
      initiator: user('alice'),
      expiresAt: '2026-11-10T18:00:45.000Z',
    });
  });

  it('keeps the invitation generation in push payloads', async () => {
    await invite();
    expect(push.ringInvitees).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: now.toISOString() }),
      ['carol'],
    );
  });

  it('ignores an old push decline action after the same person is invited again', async () => {
    await invite();
    const reject = jest.spyOn(service, 'rejectCall');
    await (service as any).declineFromPush(
      'carol',
      'call-1',
      new Date(now.getTime() - 60_000),
    );
    expect(reject).not.toHaveBeenCalled();
    expect(call.participants.at(-1).status).toBe('INVITED');
  });

  it('ignores a legacy push decline action for a re-invited participant', async () => {
    await invite();
    const reject = jest.spyOn(service, 'rejectCall');
    await (service as any).declineFromPush('carol', 'call-1', null);
    expect(reject).not.toHaveBeenCalled();
  });

  it.each(['acceptCall', 'rejectCall'] as const)(
    'rejects %s from a stale incoming-call screen',
    async (action) => {
      await invite();
      const oldInvitation = new Date(now.getTime() - 60_000);
      await expect(
        (service[action] as any).call(
          service,
          'carol',
          'call-1',
          oldInvitation,
        ),
      ).rejects.toMatchObject({ response: { errorCode: 'CALL_EXPIRED' } });
      expect(call.participants.at(-1).status).toBe('INVITED');
    },
  );

  it('does not claim a newer invitation when an old accept was already in flight', async () => {
    await invite();
    prisma.$transaction.mockImplementationOnce(async (run: any) => {
      call.participants.at(-1).invitedAt = new Date(now.getTime() + 1);
      return run(prisma);
    });
    await expect(service.acceptCall('carol', 'call-1')).rejects.toMatchObject({
      response: { errorCode: 'CALL_ENDED' },
    });
    expect(call.participants.at(-1).status).toBe('INVITED');
    expect(livekit.mintJoinToken).not.toHaveBeenCalled();
  });

  it('keeps a promoted conference alive when a direct-call leave was already in flight', async () => {
    call.sessionType = 1;
    const participant = { ...call.participants[0], call: { ...call } };
    prisma.callParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.callParticipant.update = jest.fn(async () => {
      call.sessionType = 4;
      call.participants[0].status = 'LEFT';
      call.participants.push({
        userID: 'carol',
        status: 'JOINED',
        user: user('carol'),
      });
      return { ...call.participants[0] };
    });
    prisma.callParticipant.count = jest.fn().mockResolvedValue(2);
    prisma.callSession.updateMany.mockImplementation(
      async ({ where, data }: any) => {
        if (
          where.sessionType !== undefined &&
          where.sessionType !== call.sessionType
        )
          return { count: 0 };
        Object.assign(call, data);
        return { count: 1 };
      },
    );
    livekit.deleteRoom = jest.fn();
    realtime.broadcastCallEnded = jest.fn();
    realtime.broadcastCallParticipantLeft = jest.fn();
    await service.leaveCall('alice', 'call-1');
    expect(call.status).toBe('ACTIVE');
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
    expect(realtime.broadcastCallParticipantLeft).toHaveBeenCalledWith(
      'carol',
      expect.objectContaining({ callId: 'call-1' }),
    );
  });
});
