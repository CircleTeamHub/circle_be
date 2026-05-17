import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from './icon.service';
import { RealtimeService } from 'src/realtime/realtime.service';

describe('IconService', () => {
  let service: IconService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    circleMember: {
      findMany: jest.fn(),
    },
    userDisplayIcon: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(prisma)),
  };

  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IconService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
      ],
    }).compile();

    service = module.get(IconService);
  });

  it('returns eligible system and circle icons and trims stale display selections', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      createdAt: new Date(),
      iconPreferencesInitialized: false,
    });
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        circle: {
          id: 'circle-1',
          name: 'Nbuuhbub',
          currentIconAsset: {
            id: 'asset-1',
            imageUrl: 'http://cdn.example/circle-icon.png',
          },
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([
      {
        id: 'display-1',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        circleID: null,
        sortOrder: 0,
      },
    ]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).toHaveLength(2);
    expect(result.circleIcons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          circleId: 'circle-1',
          title: 'Nbuuhbub',
        }),
      ]),
    );
    expect(prisma.userDisplayIcon.createMany).not.toHaveBeenCalled();
  });

  it('auto-initializes eligible system icons for legacy users without icon preferences', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        vipLevel: 5,
        createdAt: new Date(),
        iconPreferencesInitialized: false,
      })
      .mockResolvedValueOnce({
        iconPreferencesInitialized: false,
      });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalledWith({
      data: [
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          circleID: null,
          sortOrder: 0,
        },
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'NEW_USER',
          circleID: null,
          sortOrder: 1,
        },
      ],
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { iconPreferencesInitialized: true },
    });
    expect(result.displayIcons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'SYSTEM',
          systemKey: 'VIP',
          title: 'VIP5',
        }),
        expect.objectContaining({
          type: 'SYSTEM',
          systemKey: 'NEW_USER',
          title: '新手',
        }),
      ]),
    );
  });

  it('broadcasts user profile summary after updating display icons', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        vipLevel: 5,
        createdAt: new Date(),
        iconPreferencesInitialized: true,
      });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({ count: 1 });
    prisma.userDisplayIcon.createMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      iconPreferencesInitialized: true,
    });

    await service.updateDisplayIcons('user-1', [
      {
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        sortOrder: 0,
      } as any,
    ]);

    expect(realtimeService.broadcastUserProfileSummary).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('wraps updateDisplayIcons delete+create in a transaction', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      vipLevel: 5,
      createdAt: new Date(),
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({ count: 1 });
    prisma.userDisplayIcon.createMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({
      id: 'user-1',
      iconPreferencesInitialized: true,
    });

    await service.updateDisplayIcons('user-1', [
      {
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        sortOrder: 0,
      } as any,
    ]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.userDisplayIcon.deleteMany).toHaveBeenCalled();
    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('caches getDisplayIconsForUser results within the TTL window', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      createdAt: new Date(),
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    await service.getDisplayIconsForUser('user-1');
    const callsAfterFirst = prisma.user.findUnique.mock.calls.length;

    await service.getDisplayIconsForUser('user-1');
    await service.getDisplayIconsForUser('user-1');

    // After the first uncached call populates the cache, the next two calls
    // must not trigger any additional DB reads.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('invalidates the display icon cache after updateDisplayIcons', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      createdAt: new Date(),
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({ count: 0 });
    prisma.userDisplayIcon.createMany.mockResolvedValue({ count: 1 });
    prisma.user.update.mockResolvedValue({});

    await service.getDisplayIconsForUser('user-1');
    await service.updateDisplayIcons('user-1', [
      {
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        sortOrder: 0,
      } as any,
    ]);
    prisma.user.findUnique.mockClear();

    await service.getDisplayIconsForUser('user-1');

    // Cache was invalidated by updateDisplayIcons, so the next read hits DB.
    expect(prisma.user.findUnique).toHaveBeenCalled();
  });
});
