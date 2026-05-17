import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { RealtimeService } from 'src/realtime/realtime.service';

describe('NotificationService', () => {
  let service: NotificationService;

  const prisma = {
    notification: {
      count: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
  };

  const realtimeService = {
    broadcastSystemNotificationUnread: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  it('builds discover/profile unread summary from notification domains', async () => {
    prisma.notification.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    await expect(service.getUnreadSummary('user-1')).resolves.toEqual({
      discoverUnread: 2,
      profileUnread: 1,
      totalUnread: 3,
    });
  });

  it('marks profile-domain notifications as read for a user', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 4 });

    await expect(
      service.markProfileNotificationsRead('user-1'),
    ).resolves.toEqual({
      count: 4,
    });

    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        toUserID: 'user-1',
        deleted: false,
        read: false,
        type: { in: ['SYSTEM'] },
      },
      data: { read: true },
    });
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).toHaveBeenCalledWith('user-1');
  });

  it('skips broadcasting unread changes when no rows were updated', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.markProfileNotificationsRead('user-1'),
    ).resolves.toEqual({
      count: 0,
    });

    expect(prisma.notification.updateMany).toHaveBeenCalled();
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).not.toHaveBeenCalled();
  });
});
