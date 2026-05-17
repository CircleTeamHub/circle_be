import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from './realtime.service';

describe('RealtimeService', () => {
  let service: RealtimeService;

  const prisma = {
    friendActivity: {
      count: jest.fn(),
    },
    circleActivity: {
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

  it('builds a badge snapshot from current unread counts', async () => {
    prisma.friendActivity.count.mockResolvedValue(3);
    prisma.circleActivity.count.mockResolvedValue(5);
    prisma.notification.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    await expect(service.buildSnapshot('user-1')).resolves.toEqual({
      messagesUnread: 0,
      contactsUnread: 3,
      discoverUnread: 7,
      profileUnread: 1,
      systemUnread: 1,
      syncedAt: expect.any(String),
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
