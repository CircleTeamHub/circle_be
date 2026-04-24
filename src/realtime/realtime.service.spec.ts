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
    prisma.notification.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    await expect(service.buildSnapshot('user-1')).resolves.toEqual({
      messagesUnread: 0,
      contactsUnread: 3,
      discoverUnread: 7,
      profileUnread: 1,
      systemUnread: 1,
      syncedAt: expect.any(String),
    });
  });
});
