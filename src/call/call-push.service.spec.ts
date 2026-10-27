import { ConfigService } from '@nestjs/config';
import { CallEndReason } from 'src/generated/prisma';
import { verifyDeclineToken } from './call-decline-token';
import {
  CALL_PUSH_VERSION,
  CallPushService,
  dismissReasonFor,
  type CallPushInvite,
} from './call-push.service';

const CALL_ID = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
const CALLEE = '7d0f4a52-2c1b-4b8e-9a3e-5f6a7b8c9d0e';
const OTHER = '11111111-2222-4333-8444-555555555555';

type Row = {
  userID: string;
  token: string;
  provider: string;
  apnsEnvironment: string | null;
};

describe('CallPushService', () => {
  const now = new Date('2026-10-26T12:00:00.000Z');
  let prisma: any;
  let push: any;
  let apns: any;
  let service: CallPushService;
  let rows: Row[];

  const invite = (overrides: Partial<CallPushInvite> = {}): CallPushInvite => ({
    callId: CALL_ID,
    conversationID: 'direct:a:b',
    sessionType: 'single',
    callType: 'AUDIO',
    initiator: { id: 'caller-1', nickname: '小明' },
    expiresAt: new Date(now.getTime() + 45_000).toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers({
      now: now.getTime(),
      doNotFake: ['nextTick', 'setImmediate'],
    });
    rows = [];
    prisma = {
      devicePushToken: {
        findMany: jest.fn(async () => rows),
      },
      chatConversation: { findUnique: jest.fn().mockResolvedValue(null) },
      circle: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    push = {
      sendJPushCustomMessages: jest.fn(async (tokens: string[]) =>
        tokens.map((token) => ({ token, status: 'SENT', receiptFinal: true })),
      ),
      settleDirectOutcomes: jest.fn().mockResolvedValue(undefined),
    };
    apns = {
      isConfigured: jest.fn().mockReturnValue(true),
      send: jest.fn(async ({ token }: { token: string }) => ({
        token,
        status: 'SENT',
        receiptFinal: true,
      })),
    };
    service = new CallPushService(
      prisma,
      push,
      apns,
      new ConfigService({
        SECRET: 'unit-test-secret',
        CALL_RING_TIMEOUT_SECONDS: 45,
      }),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('only targets devices that declared call push support', async () => {
    service.ringInvitees(invite(), [CALLEE]);
    await service.flushPending();

    const where = prisma.devicePushToken.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      userID: { in: [CALLEE] },
      disabledAt: null,
      callPushVersion: { gte: CALL_PUSH_VERSION },
      // iOS 的极光 token 不在其列：iOS 来电只走 VoIP。
      OR: [
        { provider: 'apns_voip', platform: 'ios' },
        { provider: 'jpush', platform: 'android' },
      ],
    });
  });

  it('rings iOS over VoIP with a whitelisted payload and a per-user decline token', async () => {
    rows = [
      {
        userID: CALLEE,
        token: 'voip-1',
        provider: 'apns_voip',
        apnsEnvironment: 'development',
      },
    ];

    service.ringInvitees(invite(), [CALLEE]);
    await service.flushPending();

    expect(apns.send).toHaveBeenCalledTimes(1);
    const sent = apns.send.mock.calls[0][0];
    expect(sent.token).toBe('voip-1');
    expect(sent.environment).toBe('development');
    expect(sent.expiresAt).toEqual(new Date(now.getTime() + 45_000));
    const { declineToken, ...rest } = sent.payload.call;
    expect(rest).toEqual({
      v: '1',
      type: 'call.invite',
      callId: CALL_ID,
      callType: 'AUDIO',
      sessionType: 'single',
      callerId: 'caller-1',
      callerName: '小明',
      expiresAt: new Date(now.getTime() + 45_000).toISOString(),
    });
    expect(
      verifyDeclineToken(service.getDeclineKey(), CALL_ID, declineToken, now),
    ).toBe(CALLEE);
    expect(push.settleDirectOutcomes).toHaveBeenCalledWith('apns_voip', [
      { token: 'voip-1', status: 'SENT', receiptFinal: true },
    ]);
  });

  it('never puts avatars, invitee lists, rooms or tokens of the call into the push', async () => {
    rows = [
      {
        userID: CALLEE,
        token: 'jp-1',
        provider: 'jpush',
        apnsEnvironment: null,
      },
    ];

    service.ringInvitees(
      {
        ...invite(),
        initiator: {
          id: 'caller-1',
          nickname: '小明',
          avatarUrl: 'https://x/a.png',
        } as never,
        livekitToken: 'secret',
        invitees: [{ id: 'x' }],
      } as never,
      [CALLEE],
    );
    await service.flushPending();

    const extras = push.sendJPushCustomMessages.mock.calls[0][1].extras;
    expect(Object.keys(extras).sort()).toEqual(
      [
        'callId',
        'callType',
        'callerId',
        'callerName',
        'declineToken',
        'expiresAt',
        'sessionType',
        'type',
        'v',
      ].sort(),
    );
    expect(
      Object.values(extras).every((value) => typeof value === 'string'),
    ).toBe(true);
  });

  it('rings Android over JPush pass-through with a TTL of the remaining ring time', async () => {
    rows = [
      {
        userID: CALLEE,
        token: 'jp-1',
        provider: 'jpush',
        apnsEnvironment: null,
      },
      {
        userID: CALLEE,
        token: 'jp-2',
        provider: 'jpush',
        apnsEnvironment: null,
      },
      {
        userID: OTHER,
        token: 'jp-3',
        provider: 'jpush',
        apnsEnvironment: null,
      },
    ];
    jest.setSystemTime(now.getTime() + 15_000);

    service.ringInvitees(invite(), [CALLEE, OTHER]);
    await service.flushPending();

    // 每人一条：拒接令牌按人签。
    expect(push.sendJPushCustomMessages).toHaveBeenCalledTimes(2);
    const [calleeCall, otherCall] = push.sendJPushCustomMessages.mock.calls;
    expect(calleeCall[0]).toEqual(['jp-1', 'jp-2']);
    expect(calleeCall[1]).toMatchObject({
      type: 'call.invite',
      ttlSeconds: 30,
    });
    expect(otherCall[0]).toEqual(['jp-3']);
    const key = service.getDeclineKey();
    const at = new Date(now.getTime() + 15_000);
    expect(
      verifyDeclineToken(key, CALL_ID, calleeCall[1].extras.declineToken, at),
    ).toBe(CALLEE);
    expect(
      verifyDeclineToken(key, CALL_ID, otherCall[1].extras.declineToken, at),
    ).toBe(OTHER);
    expect(apns.send).not.toHaveBeenCalled();
    expect(push.settleDirectOutcomes).toHaveBeenCalledWith(
      'jpush',
      expect.any(Array),
    );
  });

  it('caps devices per user and channel at the five most recent', async () => {
    rows = Array.from({ length: 7 }, (_, index) => ({
      userID: CALLEE,
      token: `voip-${index}`,
      provider: 'apns_voip',
      apnsEnvironment: 'production',
    }));

    service.ringInvitees(invite(), [CALLEE]);
    await service.flushPending();

    expect(apns.send.mock.calls.map((call: any[]) => call[0].token)).toEqual([
      'voip-0',
      'voip-1',
      'voip-2',
      'voip-3',
      'voip-4',
    ]);
    expect(prisma.devicePushToken.findMany.mock.calls[0][0].orderBy).toEqual([
      { updatedAt: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('adds the group name for group calls and truncates long names', async () => {
    rows = [
      {
        userID: CALLEE,
        token: 'jp-1',
        provider: 'jpush',
        apnsEnvironment: null,
      },
    ];
    prisma.chatConversation.findUnique.mockResolvedValue({
      name: null,
      circleID: 'circle-1',
    });
    prisma.circle.findFirst.mockResolvedValue({
      name: '周末羽毛球'.repeat(10),
    });

    service.ringInvitees(
      invite({
        sessionType: 'group',
        conversationID: 'conv-1',
        initiator: { id: 'caller-1', nickname: '名'.repeat(40) },
      }),
      [CALLEE],
    );
    await service.flushPending();

    const extras = push.sendJPushCustomMessages.mock.calls[0][1].extras;
    expect([...extras.groupName]).toHaveLength(32);
    expect([...extras.callerName]).toHaveLength(32);
    expect(prisma.circle.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deleted: false, OR: [{ id: 'circle-1' }] },
      }),
    );
  });

  it('does not send an invite whose ring window already closed', async () => {
    rows = [
      {
        userID: CALLEE,
        token: 'jp-1',
        provider: 'jpush',
        apnsEnvironment: null,
      },
    ];

    service.ringInvitees(
      invite({ expiresAt: new Date(now.getTime() - 1).toISOString() }),
      [CALLEE],
    );
    await service.flushPending();

    expect(prisma.devicePushToken.findMany).not.toHaveBeenCalled();
    expect(push.sendJPushCustomMessages).not.toHaveBeenCalled();
  });

  it('skips VoIP when APNs credentials are missing but still rings Android', async () => {
    apns.isConfigured.mockReturnValue(false);
    rows = [
      {
        userID: CALLEE,
        token: 'voip-1',
        provider: 'apns_voip',
        apnsEnvironment: 'production',
      },
      {
        userID: CALLEE,
        token: 'jp-1',
        provider: 'jpush',
        apnsEnvironment: null,
      },
    ];

    service.ringInvitees(invite(), [CALLEE]);
    await service.flushPending();

    expect(apns.send).not.toHaveBeenCalled();
    expect(push.sendJPushCustomMessages).toHaveBeenCalledTimes(1);
  });

  it('never lets a push failure escape into the call flow', async () => {
    prisma.devicePushToken.findMany.mockRejectedValue(new Error('db down'));

    expect(() => service.ringInvitees(invite(), [CALLEE])).not.toThrow();
    await expect(service.flushPending()).resolves.toBeUndefined();
  });

  describe('dismiss', () => {
    beforeEach(() => {
      rows = [
        {
          userID: CALLEE,
          token: 'voip-1',
          provider: 'apns_voip',
          apnsEnvironment: 'production',
        },
        {
          userID: CALLEE,
          token: 'jp-1',
          provider: 'jpush',
          apnsEnvironment: null,
        },
      ];
    });

    it('dismisses ringing devices of invitees who never answered when a call ends', async () => {
      service.dismissForEndedCall(
        {
          id: CALL_ID,
          participants: [
            { userID: 'caller-1', status: 'JOINED' },
            { userID: CALLEE, status: 'MISSED' },
            { userID: OTHER, status: 'INVITED' },
            { userID: 'rejected-1', status: 'REJECTED' },
            { userID: 'left-1', status: 'LEFT' },
          ],
        },
        CallEndReason.CANCELED,
      );
      await service.flushPending();

      expect(
        prisma.devicePushToken.findMany.mock.calls[0][0].where.userID,
      ).toEqual({
        in: [CALLEE, OTHER],
      });
      // 撤销只发安卓透传：iOS 每条 VoIP 推送都得上报一通来电。
      expect(apns.send).not.toHaveBeenCalled();
      expect(push.sendJPushCustomMessages).toHaveBeenCalledWith(['jp-1'], {
        type: 'call.dismiss',
        extras: {
          v: '1',
          type: 'call.dismiss',
          callId: CALL_ID,
          reason: 'canceled',
        },
        ttlSeconds: 45,
      });
    });

    it('sends nothing when nobody is left ringing', async () => {
      service.dismissForEndedCall(
        { id: CALL_ID, participants: [{ userID: 'caller-1', status: 'LEFT' }] },
        CallEndReason.ALL_LEFT,
      );
      await service.flushPending();

      expect(prisma.devicePushToken.findMany).not.toHaveBeenCalled();
    });

    it("dismisses the user's other devices after they answer or decline", async () => {
      service.dismissForUser(CALL_ID, CALLEE, 'answered_elsewhere');
      await service.flushPending();

      expect(push.sendJPushCustomMessages).toHaveBeenCalledWith(
        ['jp-1'],
        expect.objectContaining({
          extras: expect.objectContaining({ reason: 'answered_elsewhere' }),
        }),
      );
    });

    it.each([
      [CallEndReason.CANCELED, 'canceled'],
      [CallEndReason.NO_ANSWER, 'missed'],
      [CallEndReason.ERROR, 'failed'],
      [CallEndReason.NORMAL, 'ended'],
      [CallEndReason.ALL_LEFT, 'ended'],
    ])('maps %s to %s', (endReason, reason) => {
      expect(dismissReasonFor(endReason)).toBe(reason);
    });
  });
});
