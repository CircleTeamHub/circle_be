import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from './realtime.service';

describe('RealtimeService', () => {
  let service: RealtimeService;

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
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(RealtimeService);
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
      squadRequest: null,
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
        squadRequest: null,
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
});
