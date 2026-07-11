import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { RealtimeService } from './realtime.service';

describe('RealtimeService', () => {
  let service: RealtimeService;
  const redis = {
    isEnabled: jest.fn(),
    publish: jest.fn(),
    subscribePattern: jest.fn(),
    getJson: jest.fn(),
    setJson: jest.fn(),
    getJsonWithVersion: jest.fn(),
    setJsonIfNewer: jest.fn(),
    getVersion: jest.fn(),
    setJsonIfVersionMatches: jest.fn(),
    invalidateVersionedKey: jest.fn(),
    deleteKey: jest.fn(),
  };

  const prisma = {
    friendActivity: {
      count: jest.fn(),
    },
    circlePostSignup: {
      count: jest.fn(),
    },
    notification: {
      count: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    userDisplayIcon: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    redis.isEnabled.mockReturnValue(true);
    redis.publish.mockResolvedValue(true);
    redis.subscribePattern.mockResolvedValue(true);
    redis.getJson.mockResolvedValue(null);
    redis.setJson.mockResolvedValue(true);
    redis.getJsonWithVersion.mockResolvedValue(null);
    redis.setJsonIfNewer.mockResolvedValue(true);
    redis.getVersion.mockResolvedValue('');
    redis.setJsonIfVersionMatches.mockResolvedValue(true);
    redis.invalidateVersionedKey.mockResolvedValue(true);
    redis.deleteKey.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = module.get(RealtimeService);
  });

  it('subscribes to per-user Redis realtime channels on module init', async () => {
    await service.onModuleInit();

    expect(redis.subscribePattern).toHaveBeenCalledWith(
      'circle:realtime:user:*',
      expect.any(Function),
    );
  });

  it('builds a badge snapshot keeping interaction and signup counts separate', async () => {
    prisma.friendActivity.count.mockResolvedValue(3);
    prisma.circlePostSignup.count.mockResolvedValue(4);
    prisma.notification.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    await expect(service.buildSnapshot('user-1')).resolves.toEqual({
      messagesUnread: 0,
      contactsUnread: 3,
      discoverUnread: 2,
      signupUnread: 4,
      profileUnread: 1,
      systemUnread: 1,
      syncedAt: expect.any(String),
    });
    expect(redis.setJsonIfVersionMatches).toHaveBeenCalledWith(
      'circle:hot:user:user-1:badge-snapshot',
      'circle:hot:user:user-1:badge-snapshot:version',
      '',
      expect.objectContaining({
        contactsUnread: 3,
        discoverUnread: 2,
        signupUnread: 4,
        profileUnread: 1,
      }),
      10,
    );
  });

  it('retries badge snapshot reads when invalidation wins the cache-write race', async () => {
    redis.getVersion
      .mockResolvedValueOnce('token-4')
      .mockResolvedValueOnce('token-5');
    redis.setJsonIfVersionMatches
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    prisma.friendActivity.count.mockResolvedValue(1);
    prisma.circlePostSignup.count.mockResolvedValue(2);
    prisma.notification.count.mockResolvedValue(3);

    await service.buildSnapshot('user-1');

    expect(redis.setJsonIfVersionMatches).toHaveBeenCalledTimes(2);
    expect(redis.setJsonIfVersionMatches).toHaveBeenLastCalledWith(
      'circle:hot:user:user-1:badge-snapshot',
      'circle:hot:user:user-1:badge-snapshot:version',
      'token-5',
      expect.any(Object),
      10,
    );
  });

  it('uses a cached badge snapshot when available', async () => {
    const cached = {
      messagesUnread: 0,
      contactsUnread: 1,
      discoverUnread: 2,
      signupUnread: 3,
      profileUnread: 4,
      systemUnread: 4,
      syncedAt: '2026-06-26T00:00:00.000Z',
    };
    redis.getJson.mockResolvedValueOnce(cached);

    await expect(service.buildSnapshot('user-1')).resolves.toEqual(cached);

    expect(prisma.friendActivity.count).not.toHaveBeenCalled();
    expect(prisma.notification.count).not.toHaveBeenCalled();
    expect(prisma.circlePostSignup.count).not.toHaveBeenCalled();
  });

  it('broadcastInteractionUnread emits the interaction-message unread count', async () => {
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();
    prisma.notification.count.mockResolvedValue(5);

    await service.broadcastInteractionUnread('user-1');

    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'interaction.unread.changed',
      payload: { count: 5, changedAt: expect.any(String) },
    });
  });

  it('broadcastNotificationCreated emits the unified foreground snackbar payload', () => {
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();

    service.broadcastNotificationCreated('user-1', {
      id: 'notification-1',
      type: 'TRACE_COMMENT',
      content: 'Nice trace',
      read: false,
      createdAt: '2026-06-08T00:00:00.000Z',
      fromUser: { id: 'actor-1', nickname: 'Alice', avatarUrl: null },
      fromTrace: { id: 'trace-1', excerpt: 'Trace body', firstImage: null },
      fromReply: { id: 'comment-1', content: 'Nice trace' },
      fromCircle: null,
      fromCirclePost: null,
      fromInvitation: null,
    });

    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'notification.created',
      payload: {
        id: 'notification-1',
        type: 'TRACE_COMMENT',
        content: 'Nice trace',
        read: false,
        createdAt: '2026-06-08T00:00:00.000Z',
        fromUser: { id: 'actor-1', nickname: 'Alice', avatarUrl: null },
        fromTrace: { id: 'trace-1', excerpt: 'Trace body', firstImage: null },
        fromReply: { id: 'comment-1', content: 'Nice trace' },
        fromCircle: null,
        fromCirclePost: null,
        fromInvitation: null,
      },
    });
  });

  it('broadcastCallInvite emits a token-free incoming call payload', () => {
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();

    service.broadcastCallInvite('user-2', {
      callId: 'call-1',
      conversationID: 'sg_group-1',
      sessionType: 'group',
      callType: 'AUDIO',
      initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
      invitees: [{ id: 'user-2', nickname: 'Bob', avatarUrl: null }],
      expiresAt: '2026-06-11T03:00:45.000Z',
      createdAt: '2026-06-11T03:00:00.000Z',
    });

    expect(broadcast).toHaveBeenCalledWith('user-2', {
      type: 'call.invite',
      payload: {
        callId: 'call-1',
        conversationID: 'sg_group-1',
        sessionType: 'group',
        callType: 'AUDIO',
        initiator: { id: 'user-1', nickname: 'Alice', avatarUrl: null },
        invitees: [{ id: 'user-2', nickname: 'Bob', avatarUrl: null }],
        expiresAt: '2026-06-11T03:00:45.000Z',
        createdAt: '2026-06-11T03:00:00.000Z',
      },
    });
    expect(JSON.stringify(broadcast.mock.calls[0][1])).not.toContain('token');
  });

  it('broadcastCallParticipantJoined emits joined participant updates', () => {
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();

    service.broadcastCallParticipantJoined('user-1', {
      callId: 'call-1',
      user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
      joinedAt: '2026-06-11T03:00:10.000Z',
      changedAt: '2026-06-11T03:00:10.000Z',
    });

    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'call.participant.joined',
      payload: {
        callId: 'call-1',
        user: { id: 'user-2', nickname: 'Bob', avatarUrl: null },
        joinedAt: '2026-06-11T03:00:10.000Z',
        changedAt: '2026-06-11T03:00:10.000Z',
      },
    });
  });

  it('broadcastCallEnded emits terminal call state', () => {
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();

    service.broadcastCallEnded('user-1', {
      callId: 'call-1',
      status: 'ENDED',
      endReason: 'ALL_LEFT',
      endedAt: '2026-06-11T03:02:00.000Z',
      changedAt: '2026-06-11T03:02:00.000Z',
    });

    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'call.ended',
      payload: {
        callId: 'call-1',
        status: 'ENDED',
        endReason: 'ALL_LEFT',
        endedAt: '2026-06-11T03:02:00.000Z',
        changedAt: '2026-06-11T03:02:00.000Z',
      },
    });
  });

  it('broadcastSignupUnread emits the signup-management unread count', async () => {
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();
    prisma.circlePostSignup.count.mockResolvedValue(2);

    await service.broadcastSignupUnread('user-1');

    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'circle.signup.unread.changed',
      payload: { count: 2, changedAt: expect.any(String) },
    });
    expect(redis.invalidateVersionedKey).toHaveBeenCalledWith(
      'circle:hot:user:user-1:badge-snapshot',
      'circle:hot:user:user-1:badge-snapshot:version',
    );
  });

  it('broadcastMembershipStatus can emit cached membership status', async () => {
    redis.getJsonWithVersion.mockResolvedValueOnce({
      version: 1,
      payload: {
        vipLevel: 3,
        expiredAt: null,
        changedAt: '2026-06-26T00:00:00.000Z',
      },
    });
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();

    await service.broadcastMembershipStatus('user-1');

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'membership.status.changed',
      payload: {
        vipLevel: 3,
        expiredAt: null,
        changedAt: '2026-06-26T00:00:00.000Z',
      },
    });
  });

  it('broadcastUserProfileSummary can emit cached profile summary', async () => {
    redis.getJsonWithVersion.mockResolvedValueOnce({
      version: 123,
      payload: {
        vipLevel: 4,
        creditScore: 90,
        displayIconsVersion: 123,
        changedAt: '2026-06-26T00:00:00.000Z',
      },
    });
    const broadcast = jest.spyOn(service, 'broadcast').mockImplementation();

    await service.broadcastUserProfileSummary('user-1');

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.userDisplayIcon.findFirst).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('user-1', {
      type: 'user.profile.summary.changed',
      payload: {
        vipLevel: 4,
        creditScore: 90,
        displayIconsVersion: 123,
        changedAt: '2026-06-26T00:00:00.000Z',
      },
    });
  });

  it('returns 0 for getConnectionCount when no clients registered', () => {
    expect(service.getConnectionCount('unknown-user')).toBe(0);
  });

  it('safeBroadcastAll does not throw even when callbacks fail', async () => {
    const successFn = jest.fn();
    const failFn = jest.fn(() => {
      throw new Error('broadcast failure');
    });

    await expect(
      service.safeBroadcastAll([successFn, failFn]),
    ).resolves.toBeUndefined();

    expect(successFn).toHaveBeenCalled();
    expect(failFn).toHaveBeenCalled();
  });

  it('safeBroadcastAll handles async rejections gracefully', async () => {
    const rejectFn = jest.fn(() => Promise.reject(new Error('async failure')));

    await expect(service.safeBroadcastAll([rejectFn])).resolves.toBeUndefined();

    expect(rejectFn).toHaveBeenCalled();
  });

  it('does not include the absolute balance in wallet.balance.changed events', () => {
    const broadcastSpy = jest.spyOn(service, 'broadcast').mockImplementation();

    service.broadcastWalletBalanceChanged('user-1', {
      reason: 'RECHARGE',
      delta: 100,
    });

    expect(broadcastSpy).toHaveBeenCalledWith('user-1', {
      type: 'wallet.balance.changed',
      payload: {
        delta: 100,
        reason: 'RECHARGE',
        changedAt: expect.any(String),
      },
    });
    const [, event] = broadcastSpy.mock.calls[0];
    expect((event.payload as Record<string, unknown>).balance).toBeUndefined();
  });

  it('does not include the absolute balance in wallet.recharge.completed events', () => {
    const broadcastSpy = jest.spyOn(service, 'broadcast').mockImplementation();

    service.broadcastWalletRechargeCompleted('user-1', 250);

    expect(broadcastSpy).toHaveBeenCalledWith('user-1', {
      type: 'wallet.recharge.completed',
      payload: {
        delta: 250,
        reason: 'RECHARGE',
        changedAt: expect.any(String),
      },
    });
    const [, event] = broadcastSpy.mock.calls[0];
    expect((event.payload as Record<string, unknown>).balance).toBeUndefined();
  });

  it('publishes broadcasts to a Redis user channel for other instances', () => {
    service.broadcastWalletBalanceChanged('user-1', {
      reason: 'RECHARGE',
      delta: 100,
    });

    expect(redis.publish).toHaveBeenCalledWith(
      'circle:realtime:user:user-1',
      expect.stringContaining('"type":"wallet.balance.changed"'),
    );
  });

  it('delivers Redis realtime events from other instances to local sockets', async () => {
    let handler:
      | ((channel: string, message: string) => void | Promise<void>)
      | undefined;
    redis.subscribePattern.mockImplementation(async (_pattern, callback) => {
      handler = callback;
      return true;
    });
    await service.onModuleInit();

    const socket = {
      readyState: 1,
      send: jest.fn(),
    } as any;
    service.registerClient('user-1', socket);

    await handler?.(
      'circle:realtime:user:user-1',
      JSON.stringify({
        origin: 'another-instance',
        event: {
          type: 'wallet.balance.changed',
          payload: {
            delta: 100,
            reason: 'RECHARGE',
            changedAt: '2026-06-26T00:00:00.000Z',
          },
        },
      }),
    );

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'wallet.balance.changed',
        payload: {
          delta: 100,
          reason: 'RECHARGE',
          changedAt: '2026-06-26T00:00:00.000Z',
        },
      }),
    );
  });

  it('does not redeliver an instance own cross-instance echo (origin guard)', async () => {
    let handler:
      | ((channel: string, message: string) => void | Promise<void>)
      | undefined;
    redis.subscribePattern.mockImplementation(async (_pattern, callback) => {
      handler = callback;
      return true;
    });
    await service.onModuleInit();

    // Capture THIS instance's origin id from the envelope it publishes.
    service.broadcastWalletBalanceChanged('user-1', { reason: 'X', delta: 1 });
    const [, published] = redis.publish.mock.calls[0] as [string, string];
    const origin = JSON.parse(published).origin as string;

    const socket = { readyState: 1, send: jest.fn() } as any;
    service.registerClient('user-1', socket);

    await handler?.(
      'circle:realtime:user:user-1',
      JSON.stringify({
        origin,
        event: {
          type: 'wallet.balance.changed',
          payload: { delta: 1, reason: 'X', changedAt: 'now' },
        },
      }),
    );

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('counts cross-instance messages for users not connected locally', async () => {
    let handler:
      | ((channel: string, message: string) => void | Promise<void>)
      | undefined;
    redis.subscribePattern.mockImplementation(async (_pattern, callback) => {
      handler = callback;
      return true;
    });
    await service.onModuleInit();
    expect(service.getCrossInstanceIgnoredCount()).toBe(0);

    await handler?.(
      'circle:realtime:user:absent-user',
      JSON.stringify({
        origin: 'other-instance',
        event: {
          type: 'wallet.balance.changed',
          payload: { delta: 1, reason: 'X', changedAt: 'now' },
        },
      }),
    );

    expect(service.getCrossInstanceIgnoredCount()).toBe(1);
  });

  it('drops cross-instance messages with an unknown event type', async () => {
    let handler:
      | ((channel: string, message: string) => void | Promise<void>)
      | undefined;
    redis.subscribePattern.mockImplementation(async (_pattern, callback) => {
      handler = callback;
      return true;
    });
    await service.onModuleInit();
    const socket = { readyState: 1, send: jest.fn() } as any;
    service.registerClient('user-1', socket);

    await handler?.(
      'circle:realtime:user:user-1',
      JSON.stringify({
        origin: 'other-instance',
        event: { type: 'totally.unknown.type', payload: { x: 1 } },
      }),
    );

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('retries the backplane subscription when Redis is unavailable at boot', async () => {
    jest.useFakeTimers();
    try {
      redis.subscribePattern
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await service.onModuleInit();
      expect(redis.subscribePattern).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(redis.subscribePattern).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('writes membership status with a version guard on cache miss', async () => {
    redis.getJsonWithVersion.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 2,
      updatedAt: new Date('2026-06-26T00:00:00.000Z'),
    });
    jest.spyOn(service, 'broadcast').mockImplementation();

    await service.broadcastMembershipStatus('user-1');

    expect(redis.setJsonIfNewer).toHaveBeenCalledWith(
      'circle:hot:user:user-1:membership-status',
      expect.objectContaining({ vipLevel: 2 }),
      new Date('2026-06-26T00:00:00.000Z').getTime(),
      30,
    );
  });
});
