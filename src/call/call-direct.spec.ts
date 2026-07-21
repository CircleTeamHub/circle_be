import { ConfigService } from '@nestjs/config';
import { CallErrorCode } from 'src/common/app-error-codes';
import {
  CallEndReason,
  CallParticipantStatus,
  CallStatus,
  FriendState,
} from 'src/generated/prisma';
import { CallService } from './call.service';

describe('CallService direct calls (#113 #115) + current (#FE93)', () => {
  const now = new Date('2026-07-21T03:00:00.000Z');
  let prisma: any;
  let openim: any;
  let livekit: any;
  let realtime: any;
  let service: CallService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());

    prisma = {
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([]),
      friend: { findFirst: jest.fn() },
      block: { findFirst: jest.fn() },
      user: { findMany: jest.fn() },
      callSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      callParticipant: {
        count: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    openim = {
      isGroupMember: jest.fn(),
      sendCallRecordMessage: jest.fn().mockResolvedValue(undefined),
    };
    livekit = {
      createRoom: jest.fn().mockResolvedValue(undefined),
      deleteRoom: jest.fn().mockResolvedValue(undefined),
      getClientUrl: jest.fn().mockReturnValue('wss://livekit.example.com'),
      mintJoinToken: jest.fn().mockResolvedValue('livekit-token'),
    };
    realtime = {
      broadcastCallInvite: jest.fn(),
      broadcastCallEnded: jest.fn(),
      broadcastCallCanceled: jest.fn(),
      broadcastCallParticipantLeft: jest.fn(),
      safeBroadcastAll: jest.fn(async (callbacks: Array<() => unknown>) => {
        for (const callback of callbacks) await callback();
      }),
    };
    const configValues: Record<string, unknown> = {
      // 故意压到 2：direct 呼叫必须无视这个上限
      CALL_MAX_PARTICIPANTS: 2,
      CALL_RING_TIMEOUT_SECONDS: 45,
      CALL_ENABLE_VIDEO: false,
    };
    const config = {
      get: jest.fn((key: string): unknown => configValues[key]),
    } as unknown as ConfigService;

    service = new CallService(prisma, openim, livekit, realtime, config);
  });

  afterEach(() => jest.useRealTimers());

  function mockFriendship({ friends = true, blocked = false } = {}) {
    prisma.friend.findFirst.mockResolvedValue(
      friends ? { id: 'friend-1', state: FriendState.ACCEPTED } : null,
    );
    prisma.block.findFirst.mockResolvedValue(
      blocked ? { id: 'block-1' } : null,
    );
    prisma.user.findMany.mockResolvedValue([
      { id: 'user-1', nickname: 'Alice', avatarUrl: null, status: 'ACTIVE' },
      { id: 'user-2', nickname: 'Bob', avatarUrl: null, status: 'ACTIVE' },
    ]);
  }

  async function expectErrorCode(promise: Promise<unknown>, expected: string) {
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: expected }),
    });
  }

  it('rejects a callee who is not an accepted friend with CALL_NOT_FRIEND', async () => {
    mockFriendship({ friends: false });
    await expectErrorCode(
      service.createDirectCall('user-1', {
        calleeID: 'user-2',
        callType: 'AUDIO',
      }),
      CallErrorCode.NotFriend,
    );
    expect(livekit.createRoom).not.toHaveBeenCalled();
  });

  it('rejects a blocked pair with the same CALL_NOT_FRIEND (no block-status oracle)', async () => {
    mockFriendship({ friends: true, blocked: true });
    await expectErrorCode(
      service.createDirectCall('user-1', {
        calleeID: 'user-2',
        callType: 'AUDIO',
      }),
      CallErrorCode.NotFriend,
    );
  });

  it('rejects calling yourself', async () => {
    await expectErrorCode(
      service.createDirectCall('user-1', {
        calleeID: 'user-1',
        callType: 'AUDIO',
      }),
      CallErrorCode.InviteeInvalid,
    );
  });

  it('creates a RINGING single-session call and invites the callee', async () => {
    mockFriendship();
    prisma.callSession.create.mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: now,
      participants: [
        {
          userID: 'user-1',
          status: CallParticipantStatus.JOINED,
          user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        },
        {
          userID: 'user-2',
          status: CallParticipantStatus.INVITED,
          user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        },
      ],
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
    }));

    const result = await service.createDirectCall('user-1', {
      calleeID: 'user-2',
      callType: 'AUDIO',
    });

    const createArgs = prisma.callSession.create.mock.calls[0][0];
    expect(createArgs.data.sessionType).toBe(1);
    // OpenIM 单聊会话规约：si_ + 双方去连字符 id 升序
    expect(createArgs.data.conversationID).toMatch(/^si_user1_user2$/);
    expect(result.call.sessionType).toBe('single');
    expect(realtime.broadcastCallInvite).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({ sessionType: 'single', callType: 'AUDIO' }),
    );
    expect(result.livekit.token).toBe('livekit-token');
  });

  it('does not apply CALL_MAX_PARTICIPANTS to a 2-party direct call', async () => {
    // config 里 CALL_MAX_PARTICIPANTS=2；群呼路径 [发起者+2邀请] 会炸，
    // direct 恒为 2 人且根本不查上限。
    mockFriendship();
    prisma.callSession.create.mockImplementation(async (args: any) => ({
      ...args.data,
      createdAt: now,
      participants: [],
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
    }));
    await expect(
      service.createDirectCall('user-1', {
        calleeID: 'user-2',
        callType: 'AUDIO',
      }),
    ).resolves.toBeDefined();
  });

  it('getCurrentCall returns the active session for reconnect reconciliation', async () => {
    const call = {
      id: 'call-1',
      conversationID: 'si_a_b',
      sessionType: 1,
      callType: 'AUDIO',
      status: CallStatus.ACTIVE,
      participants: [
        {
          userID: 'user-1',
          status: CallParticipantStatus.JOINED,
          user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        },
      ],
    };
    prisma.callSession.findFirst.mockResolvedValue(call);

    const result = await service.getCurrentCall('user-1');
    expect(result.call?.id).toBe('call-1');
    expect(result.call?.sessionType).toBe('single');
    expect(result.selfParticipant?.status).toBe(CallParticipantStatus.JOINED);

    prisma.callSession.findFirst.mockResolvedValue(null);
    await expect(service.getCurrentCall('user-1')).resolves.toEqual({
      call: null,
      selfParticipant: null,
    });
  });

  it('cancelCall leaves a call_record custom message in the 1:1 conversation (#115)', async () => {
    const call = {
      id: 'call-1',
      conversationID: 'si_user1_user2',
      sessionType: 1,
      callType: 'AUDIO',
      status: CallStatus.RINGING,
      initiatorID: 'user-1',
      livekitRoomName: 'room-1',
      startedAt: null,
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      participants: [
        {
          userID: 'user-1',
          status: CallParticipantStatus.JOINED,
          user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        },
        {
          userID: 'user-2',
          status: CallParticipantStatus.INVITED,
          user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        },
      ],
    };
    prisma.callSession.findUnique.mockResolvedValue(call);
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });
    prisma.callSession.update.mockResolvedValue({
      ...call,
      status: CallStatus.CANCELED,
    });

    await service.cancelCall('user-1', 'call-1');
    // fire-and-forget：驱动微任务队列
    await Promise.resolve();
    await Promise.resolve();

    expect(openim.sendCallRecordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sendID: 'user-1',
        target: { kind: 'single', recvID: 'user-2' },
        data: expect.objectContaining({
          type: 'call_record',
          endReason: CallEndReason.CANCELED,
          sessionType: 'single',
          durationSeconds: null,
        }),
        offlinePush: null,
      }),
    );
  });

  it('missed ring-timeout sends the record WITH an offline push (#115)', async () => {
    const call = {
      id: 'call-2',
      conversationID: 'si_user1_user2',
      sessionType: 1,
      callType: 'AUDIO',
      status: CallStatus.RINGING,
      initiatorID: 'user-1',
      livekitRoomName: 'room-2',
      startedAt: null,
      expiresAt: new Date(now.getTime() - 1_000),
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      participants: [
        {
          userID: 'user-1',
          status: CallParticipantStatus.JOINED,
          user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        },
        {
          userID: 'user-2',
          status: CallParticipantStatus.INVITED,
          user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        },
      ],
    };
    prisma.callSession.findMany.mockResolvedValue([call]);
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });

    await service.sweepExpiredRingingCalls();
    await Promise.resolve();
    await Promise.resolve();

    expect(openim.sendCallRecordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endReason: CallEndReason.NO_ANSWER,
        }),
        offlinePush: expect.objectContaining({ desc: '语音通话未接听' }),
      }),
    );
  });
});
