import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallErrorCode } from 'src/common/app-error-codes';
import { CircleMemberStatus } from 'src/generated/prisma';
import { callMetrics } from 'src/metrics/call-metrics';
import { CallService } from './call.service';

/**
 * 通话业务指标的调用点：发起 / 接听 / 结束各计在哪、什么情况不计，以及计数器
 * 抛错时业务结果不变。指标本身的名字、标签、桶见 src/metrics/call-metrics.spec.ts。
 */
describe('CallService call metrics', () => {
  const now = new Date('2026-10-26T03:00:00.000Z');
  const secondsAgo = (seconds: number) =>
    new Date(now.getTime() - seconds * 1000);
  const alice = { id: 'user-1', nickname: 'Alice', avatarUrl: null };
  const bob = { id: 'user-2', nickname: 'Bob', avatarUrl: null };

  let prisma: any;
  let chatService: any;
  let chatMessages: any;
  let livekit: any;
  let realtime: any;
  let privacySettings: any;
  let service: CallService;
  let setups: jest.SpyInstance;
  let accepts: jest.SpyInstance;
  let endings: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());

    prisma = {
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
      $executeRaw: jest.fn().mockResolvedValue(0),
      circle: { findFirst: jest.fn().mockResolvedValue(null) },
      circleMember: { findMany: jest.fn().mockResolvedValue([]) },
      friend: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      block: { findFirst: jest.fn().mockResolvedValue(null) },
      // 群留痕的会话解析；null = 无会话，留痕早退 —— 计数不能跟着早退。
      chatConversation: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findMany: jest.fn() },
      callSession: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      callParticipant: {
        count: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    chatService = {
      ensureDirectConversationForSettlement: jest
        .fn()
        .mockResolvedValue('conv-direct-1'),
    };
    chatMessages = {
      insertServerMessage: jest.fn().mockResolvedValue(undefined),
    };
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
      broadcastCallEnded: jest.fn(),
      broadcastCallCanceled: jest.fn(),
      safeBroadcastAll: jest.fn(async (callbacks: Array<() => unknown>) => {
        for (const callback of callbacks) await callback();
      }),
    };
    const configValues: Record<string, unknown> = {
      CALL_MAX_PARTICIPANTS: 10,
      CALL_RING_TIMEOUT_SECONDS: 45,
      CALL_ENABLE_VIDEO: false,
    };
    const config = {
      get: jest.fn((key: string): unknown => configValues[key]),
    } as unknown as ConfigService;
    privacySettings = {
      canBeCalled: jest.fn().mockResolvedValue(true),
      getSettingsForUsers: jest.fn().mockResolvedValue(new Map()),
    };

    service = new CallService(
      prisma,
      chatService,
      chatMessages,
      livekit,
      realtime,
      config,
      privacySettings,
    );

    setups = jest.spyOn(callMetrics, 'recordSetup');
    accepts = jest.spyOn(callMetrics, 'recordAccept');
    endings = jest.spyOn(callMetrics, 'recordEnding');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function mockGroupMembers() {
    prisma.circle.findFirst.mockResolvedValue({
      adminState: 'ACTIVE',
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'user-1',
    });
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'user-1', status: CircleMemberStatus.ACTIVE },
      { userID: 'user-2', status: CircleMemberStatus.ACTIVE },
    ]);
    prisma.user.findMany.mockResolvedValue([alice, bob]);
  }

  function mockFriends() {
    prisma.friend.findFirst.mockResolvedValue({ id: 'friend-1' });
    prisma.user.findMany.mockResolvedValue([alice, bob]);
  }

  /** callSession.create 回显入参并补上 include 出来的关系。 */
  function echoCreatedCall() {
    prisma.callSession.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        ...data,
        createdAt: now,
        initiator: alice,
        participants: [
          { userID: 'user-1', status: 'JOINED', user: alice },
          { userID: 'user-2', status: 'INVITED', user: bob },
        ],
      }),
    );
  }

  const startGroupCall = (idempotencyKey?: string) =>
    service.createGroupCall(
      'user-1',
      {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      },
      idempotencyKey,
    );

  const startDirectCall = (idempotencyKey?: string) =>
    service.createDirectCall(
      'user-1',
      { calleeID: 'user-2', callType: 'AUDIO' },
      idempotencyKey,
    );

  function existingRingingCall(sessionType: number) {
    return {
      id: 'call-1',
      conversationID: sessionType === 3 ? 'sg_group-1' : 'direct:user-1:user-2',
      sessionType,
      callType: 'AUDIO',
      status: 'RINGING',
      livekitRoomName: 'circle_call_1',
      initiatorID: 'user-1',
      initiator: alice,
      startedAt: null,
      expiresAt: new Date(now.getTime() + 45_000),
      participants: [
        { userID: 'user-1', status: 'JOINED', user: alice },
        { userID: 'user-2', status: 'INVITED', user: bob },
      ],
    };
  }

  async function answeredDuration(kind: string) {
    const metric = callMetrics.registry.getSingleMetric(
      'circle_call_answered_duration_seconds',
    )!;
    const { values } = (await metric.get()) as unknown as {
      values: Array<{
        metricName?: string;
        labels: Record<string, unknown>;
        value: number;
      }>;
    };
    const pick = (name: string) =>
      values.find(
        (value) => value.metricName === name && value.labels.kind === kind,
      )?.value ?? 0;
    return {
      count: pick('circle_call_answered_duration_seconds_count'),
      sum: pick('circle_call_answered_duration_seconds_sum'),
    };
  }

  const throwingRecorder = () => {
    throw new Error('registry broken');
  };

  describe('circle_call_setups_total', () => {
    it('counts a created group call once as started', async () => {
      mockGroupMembers();
      echoCreatedCall();

      await startGroupCall();

      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('group', 'started');
    });

    it('labels 1:1 calls as direct', async () => {
      mockFriends();
      echoCreatedCall();

      await startDirectCall();

      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('direct', 'started');
    });

    it('counts the pre-check CALL_BUSY as busy', async () => {
      mockGroupMembers();
      prisma.callParticipant.findFirst.mockResolvedValue({ id: 'p-busy' });

      await expect(startGroupCall()).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: CallErrorCode.Busy }),
      });

      expect(livekit.createRoom).not.toHaveBeenCalled();
      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('group', 'busy');
    });

    it('counts the locked re-check CALL_BUSY as busy too', async () => {
      mockFriends();
      prisma.callParticipant.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'p-busy' });

      await expect(startDirectCall()).rejects.toThrow(ConflictException);

      expect(livekit.createRoom).toHaveBeenCalled();
      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('direct', 'busy');
    });

    it('counts a LiveKit room creation failure as livekit_unavailable', async () => {
      mockGroupMembers();
      livekit.createRoom.mockRejectedValue(
        new ServiceUnavailableException('LiveKit room creation failed'),
      );

      await expect(startGroupCall()).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('group', 'livekit_unavailable');
    });

    it('counts an unconfigured LiveKit at token time as livekit_unavailable and the ERROR ending once', async () => {
      mockGroupMembers();
      echoCreatedCall();
      livekit.mintJoinToken.mockRejectedValue(
        new ServiceUnavailableException('LiveKit is not configured'),
      );

      await expect(startGroupCall()).rejects.toThrow(
        'LiveKit is not configured',
      );

      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('group', 'livekit_unavailable');
      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith({
        kind: 'group',
        reason: 'ERROR',
        startedAt: undefined,
        endedAt: now,
      });
    });

    it('counts any other error while signing the token as failed, not livekit_unavailable', async () => {
      // 签 token 是本地算 JWT：这一步的非 503 错误来自访问复检的数据库查询。记成
      // livekit_unavailable 会让数据库故障里的告警把人指到 LiveKit 那边去。
      mockGroupMembers();
      echoCreatedCall();
      livekit.mintJoinToken.mockRejectedValue(new Error('db down'));

      await expect(startGroupCall()).rejects.toThrow('db down');

      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('group', 'failed');
    });

    it('does not count the ERROR ending when the failure write loses the race', async () => {
      mockGroupMembers();
      echoCreatedCall();
      livekit.mintJoinToken.mockRejectedValue(new Error('livekit down'));
      prisma.callSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(startGroupCall()).rejects.toThrow('livekit down');

      expect(endings).not.toHaveBeenCalled();
    });

    it('counts a failing create transaction as failed', async () => {
      mockGroupMembers();
      prisma.callSession.create.mockRejectedValue(new Error('db down'));

      await expect(startGroupCall()).rejects.toThrow('db down');

      expect(setups).toHaveBeenCalledTimes(1);
      expect(setups).toHaveBeenCalledWith('group', 'failed');
    });

    it('does not count an idempotent replay found before the lock', async () => {
      mockGroupMembers();
      prisma.callSession.findFirst.mockResolvedValue(existingRingingCall(3));

      const result = await startGroupCall('request-1');

      expect(result.call.id).toBe('call-1');
      expect(setups).not.toHaveBeenCalled();
    });

    it('does not count an idempotent replay even when its token mint fails', async () => {
      mockGroupMembers();
      prisma.callSession.findFirst.mockResolvedValue(existingRingingCall(3));
      livekit.mintJoinToken.mockRejectedValue(new Error('livekit down'));

      await expect(startGroupCall('request-1')).rejects.toThrow('livekit down');

      expect(setups).not.toHaveBeenCalled();
    });

    it('does not count an idempotent replay found inside the lock', async () => {
      mockFriends();
      prisma.callSession.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingRingingCall(1));

      const result = await startDirectCall('request-1');

      expect(result.call.id).toBe('call-1');
      expect(prisma.callSession.create).not.toHaveBeenCalled();
      expect(setups).not.toHaveBeenCalled();
    });

    it('does not count validation rejections before the pipeline', async () => {
      prisma.user.findMany.mockResolvedValue([alice, bob]);
      // 非好友：入口校验拒绝。

      await expect(startDirectCall()).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: CallErrorCode.NotFriend,
        }),
      });

      expect(setups).not.toHaveBeenCalled();
    });

    it('does not count the locked friend/block re-check rejection either', async () => {
      prisma.user.findMany.mockResolvedValue([alice, bob]);
      // 预检时还是好友，锁内复检时已被拉黑/删除。
      prisma.friend.findFirst
        .mockResolvedValueOnce({ id: 'friend-1' })
        .mockResolvedValueOnce(null);

      await expect(startDirectCall()).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: CallErrorCode.NotFriend,
        }),
      });

      expect(livekit.createRoom).toHaveBeenCalled();
      expect(setups).not.toHaveBeenCalled();
    });

    it('a throwing recorder changes neither a started call nor a busy rejection', async () => {
      setups.mockImplementation(throwingRecorder);
      mockGroupMembers();
      echoCreatedCall();

      const started = await startGroupCall();
      expect(started.call.status).toBe('RINGING');
      expect(started.livekit.token).toBe('livekit-token');
      expect(realtime.broadcastCallInvite).toHaveBeenCalled();

      prisma.callParticipant.findFirst.mockResolvedValue({ id: 'p-busy' });
      await expect(startGroupCall()).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: CallErrorCode.Busy }),
      });
    });
  });

  describe('circle_call_accepts_total', () => {
    function invitedParticipant(
      sessionType: number,
      callOverrides: Record<string, unknown> = {},
    ) {
      return {
        callID: 'call-1',
        userID: 'user-2',
        status: 'INVITED',
        user: bob,
        call: { ...existingRingingCall(sessionType), ...callOverrides },
      };
    }

    function mockAcceptableCall(sessionType: number) {
      if (sessionType === 3) mockGroupMembers();
      else mockFriends();
      const participant = invitedParticipant(sessionType);
      prisma.callParticipant.findUnique.mockResolvedValue(participant);
      prisma.callSession.findUnique.mockResolvedValue({
        ...participant.call,
        status: 'ACTIVE',
        startedAt: now,
      });
    }

    it('counts a group accept as accepted', async () => {
      mockAcceptableCall(3);

      await service.acceptCall('user-2', 'call-1');

      expect(accepts).toHaveBeenCalledTimes(1);
      expect(accepts).toHaveBeenCalledWith('group', 'accepted');
    });

    it('counts a 1:1 accept as direct accepted', async () => {
      mockAcceptableCall(1);

      await service.acceptCall('user-2', 'call-1');

      expect(accepts).toHaveBeenCalledTimes(1);
      expect(accepts).toHaveBeenCalledWith('direct', 'accepted');
    });

    it('counts accepting an already-ended call as too_late', async () => {
      prisma.callParticipant.findUnique.mockResolvedValue(
        invitedParticipant(3, { status: 'CANCELED' }),
      );

      await expect(
        service.acceptCall('user-2', 'call-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: CallErrorCode.Ended }),
      });

      expect(accepts).toHaveBeenCalledTimes(1);
      expect(accepts).toHaveBeenCalledWith('group', 'too_late');
    });

    it('counts an expired ring as too_late and its NO_ANSWER ending once', async () => {
      prisma.callParticipant.findUnique.mockResolvedValue(
        invitedParticipant(1, { expiresAt: secondsAgo(1) }),
      );

      await expect(
        service.acceptCall('user-2', 'call-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: CallErrorCode.Expired,
        }),
      });

      expect(accepts).toHaveBeenCalledTimes(1);
      expect(accepts).toHaveBeenCalledWith('direct', 'too_late');
      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'direct',
          reason: 'NO_ANSWER',
          startedAt: null,
        }),
      );
    });

    it('counts losing the RINGING→ACTIVE write to a cancel as too_late', async () => {
      mockAcceptableCall(3);
      prisma.callSession.updateMany.mockResolvedValue({ count: 0 });
      prisma.callSession.findUnique.mockResolvedValue({ status: 'CANCELED' });

      await expect(
        service.acceptCall('user-2', 'call-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: CallErrorCode.Ended }),
      });

      expect(livekit.mintJoinToken).not.toHaveBeenCalled();
      expect(accepts).toHaveBeenCalledTimes(1);
      expect(accepts).toHaveBeenCalledWith('group', 'too_late');
    });

    it('counts a participant already swept to MISSED as too_late', async () => {
      mockAcceptableCall(3);
      prisma.callParticipant.updateMany.mockResolvedValue({ count: 0 });
      prisma.callParticipant.findUnique
        .mockResolvedValueOnce(invitedParticipant(3))
        .mockResolvedValueOnce({ status: 'MISSED' });

      await expect(service.acceptCall('user-2', 'call-1')).rejects.toThrow(
        ConflictException,
      );

      expect(accepts).toHaveBeenCalledWith('group', 'too_late');
    });

    it('does not count the losing half of a double-tap accept', async () => {
      // 双击竞态：赢家已把参与者改成 JOINED 并计过 accepted，输家幂等成功、不再计。
      mockAcceptableCall(3);
      prisma.callParticipant.updateMany.mockResolvedValue({ count: 0 });
      prisma.callSession.updateMany.mockResolvedValue({ count: 0 });
      prisma.callParticipant.findUnique
        .mockResolvedValueOnce(invitedParticipant(3))
        .mockResolvedValueOnce({ status: 'JOINED' })
        .mockResolvedValueOnce({ status: 'JOINED', user: bob });

      const result = await service.acceptCall('user-2', 'call-1');

      expect(result.livekit.token).toBe('livekit-token');
      expect(accepts).not.toHaveBeenCalled();
    });

    it('does not count a repeated accept from an already-joined participant', async () => {
      mockGroupMembers();
      prisma.callParticipant.findUnique.mockResolvedValue({
        ...invitedParticipant(3, { status: 'ACTIVE' }),
        status: 'JOINED',
      });

      await service.acceptCall('user-2', 'call-1');

      expect(accepts).not.toHaveBeenCalled();
    });

    it('does not count not-invited / not-found client errors', async () => {
      prisma.callParticipant.findUnique.mockResolvedValueOnce({
        ...invitedParticipant(3),
        status: 'LEFT',
      });
      await expect(
        service.acceptCall('user-2', 'call-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: CallErrorCode.NotInvited,
        }),
      });

      prisma.callParticipant.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.acceptCall('user-2', 'call-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: CallErrorCode.NotFound,
        }),
      });

      expect(accepts).not.toHaveBeenCalled();
    });

    it('does not count an access re-check rejection (unfriended while ringing)', async () => {
      prisma.callParticipant.findUnique.mockResolvedValue(
        invitedParticipant(1),
      );
      prisma.friend.findFirst.mockResolvedValue(null);

      await expect(
        service.acceptCall('user-2', 'call-1'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: CallErrorCode.NotFriend,
        }),
      });

      expect(accepts).not.toHaveBeenCalled();
    });

    it('counts a token mint failure after the claim as failed', async () => {
      mockAcceptableCall(1);
      livekit.mintJoinToken.mockRejectedValue(
        new ServiceUnavailableException('LiveKit is not configured'),
      );

      await expect(service.acceptCall('user-2', 'call-1')).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(accepts).toHaveBeenCalledTimes(1);
      expect(accepts).toHaveBeenCalledWith('direct', 'failed');
    });

    it('counts a failing accept transaction as failed', async () => {
      mockAcceptableCall(3);
      prisma.$transaction.mockRejectedValue(new Error('db down'));

      await expect(service.acceptCall('user-2', 'call-1')).rejects.toThrow(
        'db down',
      );

      expect(accepts).toHaveBeenCalledWith('group', 'failed');
    });

    it('a throwing recorder does not change the accept result', async () => {
      accepts.mockImplementation(throwingRecorder);
      mockAcceptableCall(3);

      const result = await service.acceptCall('user-2', 'call-1');

      expect(result.livekit.token).toBe('livekit-token');
      expect(realtime.broadcastCallParticipantJoined).toHaveBeenCalled();
    });
  });

  describe('circle_call_endings_total / circle_call_answered_duration_seconds', () => {
    function joinedParticipant(call: Record<string, unknown>) {
      return {
        callID: 'call-1',
        userID: 'user-2',
        status: 'JOINED',
        user: bob,
        call,
      };
    }

    function activeCall(sessionType: number, answeredSecondsAgo: number) {
      return {
        ...existingRingingCall(sessionType),
        status: 'ACTIVE',
        startedAt: secondsAgo(answeredSecondsAgo),
        participants: [
          { userID: 'user-1', status: 'JOINED', user: alice },
          { userID: 'user-2', status: 'JOINED', user: bob },
        ],
      };
    }

    function mockGroupAllLeft(transitionCount: number) {
      const call = activeCall(3, 90);
      prisma.callParticipant.findUnique.mockResolvedValue(
        joinedParticipant(call),
      );
      prisma.callParticipant.update.mockResolvedValue({ user: bob });
      prisma.callParticipant.count.mockResolvedValue(0);
      prisma.callSession.updateMany.mockResolvedValue({
        count: transitionCount,
      });
      prisma.callSession.findUnique.mockResolvedValue({
        ...call,
        status: 'ENDED',
        endReason: 'ALL_LEFT',
        endedAt: now,
      });
    }

    function mockSingleFirstLeave(transitionCount: number) {
      prisma.callParticipant.findUnique.mockResolvedValue(
        joinedParticipant(activeCall(1, 125)),
      );
      prisma.callParticipant.update.mockResolvedValue({ user: bob });
      prisma.callSession.updateMany.mockResolvedValue({
        count: transitionCount,
      });
    }

    function mockCancel(transitionCount: number) {
      const ringing = existingRingingCall(1);
      prisma.callSession.findUnique
        .mockResolvedValueOnce(ringing)
        .mockResolvedValueOnce({
          ...ringing,
          status: 'CANCELED',
          endReason: 'CANCELED',
          endedAt: now,
        });
      prisma.callSession.updateMany.mockResolvedValue({
        count: transitionCount,
      });
    }

    it('counts a group all-left ending once with its answered duration', async () => {
      mockGroupAllLeft(1);
      const before = await answeredDuration('group');

      await service.leaveCall('user-2', 'call-1');

      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith({
        kind: 'group',
        reason: 'ALL_LEFT',
        startedAt: secondsAgo(90),
        endedAt: now,
      });
      const after = await answeredDuration('group');
      expect(after.count - before.count).toBe(1);
      expect(after.sum - before.sum).toBe(90);
    });

    it('does not count a group all-left whose write lost the race', async () => {
      mockGroupAllLeft(0);

      await service.leaveCall('user-2', 'call-1');

      expect(endings).not.toHaveBeenCalled();
    });

    it('counts a 1:1 first-leave ending once as direct, answered, with duration', async () => {
      mockSingleFirstLeave(1);
      const before = await answeredDuration('direct');

      await service.leaveCall('user-2', 'call-1');

      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith({
        kind: 'direct',
        reason: 'ALL_LEFT',
        startedAt: secondsAgo(125),
        endedAt: now,
      });
      const after = await answeredDuration('direct');
      expect(after.count - before.count).toBe(1);
      expect(after.sum - before.sum).toBe(125);
    });

    it('does not count the second hang-up of a 1:1 call', async () => {
      mockSingleFirstLeave(0);

      await service.leaveCall('user-2', 'call-1');

      expect(endings).not.toHaveBeenCalled();
    });

    it('counts a cancel once as unanswered and observes no duration', async () => {
      mockCancel(1);
      const before = await answeredDuration('direct');

      await service.cancelCall('user-1', 'call-1');

      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith({
        kind: 'direct',
        reason: 'CANCELED',
        startedAt: null,
        endedAt: now,
      });
      expect(await answeredDuration('direct')).toEqual(before);
    });

    it('does not count the losing concurrent cancel', async () => {
      mockCancel(0);

      const result = await service.cancelCall('user-1', 'call-1');

      expect(result.status).toBe('CANCELED');
      expect(endings).not.toHaveBeenCalled();
    });

    it('counts a ring timeout swept to MISSED once as no_answer', async () => {
      prisma.callSession.findMany.mockResolvedValue([existingRingingCall(3)]);

      await service.sweepExpiredRingingCalls();

      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith({
        kind: 'group',
        reason: 'NO_ANSWER',
        startedAt: null,
        endedAt: now,
      });
    });

    it('does not count a ring timeout another sweeper already ended', async () => {
      prisma.callSession.findMany.mockResolvedValue([existingRingingCall(3)]);
      prisma.callSession.updateMany.mockResolvedValue({ count: 0 });

      await service.sweepExpiredRingingCalls();

      expect(endings).not.toHaveBeenCalled();
    });

    it('counts a LiveKit room_finished once as normal and reports it handled', async () => {
      prisma.callSession.findUnique.mockResolvedValue(activeCall(1, 30));

      await expect(
        service.handleLiveKitWebhook({
          event: 'room_finished',
          room: { name: 'circle_call_1' },
        }),
      ).resolves.toBe('handled');

      expect(endings).toHaveBeenCalledTimes(1);
      expect(endings).toHaveBeenCalledWith({
        kind: 'direct',
        reason: 'NORMAL',
        startedAt: secondsAgo(30),
        endedAt: now,
      });
    });

    it('a retried room_finished is still handled but not counted again', async () => {
      // 500 之后 LiveKit 重投：条件写落空，结束计数不能再 +1。
      prisma.callSession.findUnique.mockResolvedValue(activeCall(1, 30));
      prisma.callSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.handleLiveKitWebhook({
          event: 'room_finished',
          room: { name: 'circle_call_1' },
        }),
      ).resolves.toBe('handled');

      expect(endings).not.toHaveBeenCalled();
    });

    it('reports other events, nameless rooms and unknown rooms as ignored', async () => {
      prisma.callSession.findUnique.mockResolvedValue(null);

      await expect(
        service.handleLiveKitWebhook({
          event: 'participant_joined',
          room: { name: 'circle_call_1' },
        }),
      ).resolves.toBe('ignored');
      await expect(
        service.handleLiveKitWebhook({
          event: 'room_finished',
          room: { name: '  ' },
        }),
      ).resolves.toBe('ignored');
      await expect(
        service.handleLiveKitWebhook({
          event: 'room_finished',
          room: { name: 'someone_elses_room' },
        }),
      ).resolves.toBe('ignored');

      expect(prisma.callSession.updateMany).not.toHaveBeenCalled();
      expect(endings).not.toHaveBeenCalled();
    });

    it('a throwing recorder does not change the call teardown', async () => {
      endings.mockImplementation(throwingRecorder);
      mockCancel(1);

      const result = await service.cancelCall('user-1', 'call-1');

      expect(result.status).toBe('CANCELED');
      expect(livekit.deleteRoom).toHaveBeenCalledWith('circle_call_1');
      expect(realtime.broadcastCallCanceled).toHaveBeenCalled();
      // 留痕照发：计数抛错发生在留痕之前，不能把它带走。
      await jest.runAllTimersAsync();
      expect(chatMessages.insertServerMessage).toHaveBeenCalledWith(
        'conv-direct-1',
        expect.objectContaining({
          clientMessageId: 'call_record_call-1',
        }),
      );
    });
  });
});
