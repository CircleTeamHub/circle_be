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
    // CAS 转换（review 修复）：updateMany 赢家才继续；随后 findUnique 取终态
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callSession.findUnique
      .mockResolvedValueOnce(call)
      .mockResolvedValue({ ...call, status: CallStatus.CANCELED });

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

  // ── PR #119 review 修复回归 ──

  it('re-asserts friend/block inside the locked transaction (concurrent block)', async () => {
    mockFriendship({ friends: true, blocked: false });
    // 预检通过后、锁内复检时对方已拉黑：第 2 次 block.findFirst 返回命中
    prisma.block.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'block-1' });

    await expectErrorCode(
      service.createDirectCall('user-1', {
        calleeID: 'user-2',
        callType: 'AUDIO',
      }),
      CallErrorCode.NotFriend,
    );
    // 锁内复检失败必须发生在会话落库之前，且没有任何邀请广播发出
    expect(prisma.callSession.create).not.toHaveBeenCalled();
    expect(realtime.broadcastCallInvite).not.toHaveBeenCalled();
  });

  it('getCurrentCall ignores an expired RINGING call the sweeper has not reaped yet', async () => {
    prisma.callSession.findFirst.mockResolvedValue(null);

    const result = await service.getCurrentCall('user-1');

    expect(result).toEqual({ call: null, selfParticipant: null });
    const where = prisma.callSession.findFirst.mock.calls[0][0].where;
    // RINGING 分支必须钳 expiresAt > now；ACTIVE 不受影响
    expect(where.OR).toEqual([
      { status: CallStatus.ACTIVE },
      { status: CallStatus.RINGING, expiresAt: null },
      { status: CallStatus.RINGING, expiresAt: { gt: expect.any(Date) } },
    ]);
  });

  it('does NOT send the missed-call offline push when the last invitee rejects', async () => {
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
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: CallParticipantStatus.INVITED,
      call,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.update.mockResolvedValue({
      userID: 'user-2',
      status: CallParticipantStatus.REJECTED,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    prisma.callParticipant.count.mockResolvedValue(0); // 再无剩余被叫
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });
    realtime.broadcastCallParticipantRejected = jest.fn();

    await service.rejectCall('user-2', 'call-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(openim.sendCallRecordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endReason: CallEndReason.NO_ANSWER,
        }),
        // 刚拒接的人不该再收到「未接来电」离线推送
        offlinePush: null,
      }),
    );
  });

  it('only the winning cancel emits the call record (concurrent cancels)', async () => {
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
    const canceled = { ...call, status: CallStatus.CANCELED };
    // 两个请求都读到 RINGING（都过了前置检查）
    prisma.callSession.findUnique.mockResolvedValue(call);
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });
    // CAS：第一个转换成功，第二个 0 行 → 幂等返回，不再发留痕
    prisma.callSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    prisma.callSession.findUnique
      .mockResolvedValueOnce(call) // 请求 A 前置读
      .mockResolvedValueOnce(call) // 请求 B 前置读
      .mockResolvedValue(canceled); // 之后的终态读

    const [a, b] = await Promise.all([
      service.cancelCall('user-1', 'call-1'),
      service.cancelCall('user-1', 'call-1'),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(a.status).toBe(CallStatus.CANCELED);
    expect(b.status).toBe(CallStatus.CANCELED);
    expect(openim.sendCallRecordMessage).toHaveBeenCalledTimes(1);
  });

  it('ends an ACTIVE 1:1 call for BOTH sides on the first leave', async () => {
    const call = {
      id: 'call-1',
      conversationID: 'si_user1_user2',
      sessionType: 1,
      callType: 'AUDIO',
      status: CallStatus.ACTIVE,
      initiatorID: 'user-1',
      livekitRoomName: 'room-1',
      startedAt: new Date(now.getTime() - 65_000),
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      participants: [
        {
          userID: 'user-1',
          status: CallParticipantStatus.JOINED,
          user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        },
        {
          userID: 'user-2',
          status: CallParticipantStatus.JOINED,
          user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        },
      ],
    };
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-1',
      status: CallParticipantStatus.JOINED,
      call,
      user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
    });
    prisma.callParticipant.update.mockResolvedValue({
      userID: 'user-1',
      status: CallParticipantStatus.LEFT,
      user: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
    });
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });

    await service.leaveCall('user-1', 'call-1');
    await Promise.resolve();
    await Promise.resolve();

    // 另一方还 JOINED，也直接终局：CAS 转换 + 删房 + 终局广播 + 留痕
    expect(prisma.callSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1', status: CallStatus.ACTIVE },
        data: expect.objectContaining({
          status: CallStatus.ENDED,
          endReason: CallEndReason.ALL_LEFT,
        }),
      }),
    );
    expect(livekit.deleteRoom).toHaveBeenCalledWith('room-1');
    expect(realtime.broadcastCallEnded).toHaveBeenCalledTimes(2);
    expect(openim.sendCallRecordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endReason: CallEndReason.ALL_LEFT,
          durationSeconds: 65,
        }),
      }),
    );
    // joinedCount 群路径完全没被走到
    expect(prisma.callParticipant.count).not.toHaveBeenCalled();
  });

  it('re-checks friend/block before ACCEPT of a 1:1 call (round 2)', async () => {
    const call = {
      id: 'call-1',
      conversationID: 'si_user1_user2',
      sessionType: 1,
      callType: 'AUDIO',
      status: CallStatus.RINGING,
      initiatorID: 'user-1',
      livekitRoomName: 'room-1',
      expiresAt: new Date(now.getTime() + 30_000),
      participants: [],
    };
    prisma.callParticipant.findUnique.mockResolvedValue({
      callID: 'call-1',
      userID: 'user-2',
      status: CallParticipantStatus.INVITED,
      call,
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
    });
    // 邀请创建后被叫拉黑了发起方
    prisma.friend.findFirst.mockResolvedValue({ id: 'friend-1' });
    prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });

    await expectErrorCode(
      service.acceptCall('user-2', 'call-1'),
      CallErrorCode.NotFriend,
    );
    // 绝不能把通话推进 ACTIVE / 发 LiveKit token
    expect(livekit.mintJoinToken).not.toHaveBeenCalled();
  });

  it('call records carry a stable clientMsgID and group misses do not offline-push (round 2)', async () => {
    const groupCall = {
      id: 'gcall-1',
      conversationID: 'sg_group-1',
      sessionType: 3,
      callType: 'AUDIO',
      status: CallStatus.RINGING,
      initiatorID: 'user-1',
      livekitRoomName: 'room-g',
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
    prisma.callSession.findMany.mockResolvedValue([groupCall]);
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });

    await service.sweepExpiredRingingCalls();
    await Promise.resolve();
    await Promise.resolve();

    expect(openim.sendCallRecordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'group', groupID: 'group-1' },
        // 重试幂等键：固定 call_record_<id>
        clientMsgID: 'call_record_gcall-1',
        // 群聊未接绝不 offlinePush（会推给全群非被邀成员）
        offlinePush: null,
      }),
    );
  });

  it('retries a transient call-record send failure before giving up', async () => {
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
    const canceled = { ...call, status: CallStatus.CANCELED };
    prisma.callSession.findUnique
      .mockResolvedValueOnce(call)
      .mockResolvedValue(canceled);
    prisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.callParticipant.updateMany.mockResolvedValue({ count: 1 });
    openim.sendCallRecordMessage
      .mockRejectedValueOnce(new Error('admin token expired'))
      .mockResolvedValueOnce(undefined);

    await service.cancelCall('user-1', 'call-1');
    // 第一次尝试失败 → 1s 退避 → 第二次成功
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(openim.sendCallRecordMessage).toHaveBeenCalledTimes(2);
  });
});
