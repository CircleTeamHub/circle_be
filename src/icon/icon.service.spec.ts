import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from './icon.service';
import { RealtimeService } from 'src/realtime/realtime.service';

describe('IconService', () => {
  let service: IconService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    circleMember: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
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
    invalidateUserProfileSummaryCache: jest.fn(() => Promise.resolve()),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.circleMember.findFirst.mockResolvedValue(null);

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
      receivedLikeCount: 0,
      createdAt: new Date(),
      status: 'ACTIVE',
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

    expect(result.systemIcons).toHaveLength(6);
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

  it('returns every VIP badge up to the current VIP level as selectable options', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
      createdAt: new Date(0),
      status: 'ACTIVE',
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([
      {
        id: 'display-vip-3',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP3',
        circleID: null,
        sortOrder: 0,
      },
    ]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons
        .filter((icon) => icon.systemKey === 'VIP')
        .map((icon) => ({
          title: icon.title,
          systemVariant: icon.systemVariant,
          selected: icon.selected,
        })),
    ).toEqual([
      { title: 'VIP1', systemVariant: 'VIP1', selected: false },
      { title: 'VIP2', systemVariant: 'VIP2', selected: false },
      { title: 'VIP3', systemVariant: 'VIP3', selected: true },
      { title: 'VIP4', systemVariant: 'VIP4', selected: false },
      { title: 'VIP5', systemVariant: 'VIP5', selected: false },
    ]);
  });

  it('maps migrated legacy VIP placeholder variants to the highest eligible VIP badge', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
      createdAt: new Date(0),
      status: 'ACTIVE',
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([
      {
        id: 'display-vip-legacy',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP',
        circleID: null,
        sortOrder: 0,
      },
    ]);

    const result = await service.getIconOptions('user-1');

    expect(prisma.userDisplayIcon.deleteMany).not.toHaveBeenCalled();
    expect(result.displayIcons).toEqual([
      expect.objectContaining({
        systemKey: 'VIP',
        systemVariant: 'VIP5',
        title: 'VIP5',
      }),
    ]);
    expect(
      result.systemIcons
        .filter((icon) => icon.systemKey === 'VIP')
        .map((icon) => ({
          variant: icon.systemVariant,
          selected: icon.selected,
        })),
    ).toEqual([
      { variant: 'VIP1', selected: false },
      { variant: 'VIP2', selected: false },
      { variant: 'VIP3', selected: false },
      { variant: 'VIP4', selected: false },
      { variant: 'VIP5', selected: true },
    ]);
  });

  it('returns every earned top-collaborator tier as selectable options', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 10_000,
      createdAt: new Date(0),
      status: 'ACTIVE',
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons
        .filter((icon) => icon.systemKey === 'TOP_COLLABORATOR')
        .map((icon) => ({
          title: icon.title,
          systemVariant: icon.systemVariant,
          recognitionCount: icon.recognitionCount,
        })),
    ).toEqual([
      {
        title: '合作达人1',
        systemVariant: 'TOP_COLLABORATOR_1',
        recognitionCount: 100,
      },
      {
        title: '合作达人2',
        systemVariant: 'TOP_COLLABORATOR_2',
        recognitionCount: 1000,
      },
      {
        title: '合作达人3',
        systemVariant: 'TOP_COLLABORATOR_3',
        recognitionCount: 10000,
      },
    ]);
  });

  it('returns previous and current variants for every leveled system badge', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 10_000,
      createdAt: new Date(0),
      status: 'ACTIVE',
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    const leveledOptions = result.systemIcons
      .filter((icon) => ['VIP', 'TOP_COLLABORATOR'].includes(icon.systemKey))
      .map((icon) => ({
        systemKey: icon.systemKey,
        title: icon.title,
        systemVariant: icon.systemVariant,
      }));

    expect(leveledOptions).toEqual([
      { systemKey: 'VIP', title: 'VIP1', systemVariant: 'VIP1' },
      { systemKey: 'VIP', title: 'VIP2', systemVariant: 'VIP2' },
      { systemKey: 'VIP', title: 'VIP3', systemVariant: 'VIP3' },
      { systemKey: 'VIP', title: 'VIP4', systemVariant: 'VIP4' },
      { systemKey: 'VIP', title: 'VIP5', systemVariant: 'VIP5' },
      {
        systemKey: 'TOP_COLLABORATOR',
        title: '合作达人1',
        systemVariant: 'TOP_COLLABORATOR_1',
      },
      {
        systemKey: 'TOP_COLLABORATOR',
        title: '合作达人2',
        systemVariant: 'TOP_COLLABORATOR_2',
      },
      {
        systemKey: 'TOP_COLLABORATOR',
        title: '合作达人3',
        systemVariant: 'TOP_COLLABORATOR_3',
      },
    ]);
  });

  it('auto-initializes eligible system icons for legacy users without icon preferences', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        vipLevel: 5,
        receivedLikeCount: 10_000,
        createdAt: new Date(),
        status: 'ACTIVE',
        phoneNumber: '13800138000',
        wechat: 'wxid_user1',
        qq: '932567218',
        privacySetting: {
          showPhone: true,
          showWechat: true,
          showQQ: true,
        },
        iconPreferencesInitialized: false,
      })
      .mockResolvedValueOnce({
        iconPreferencesInitialized: false,
      });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.circleMember.findFirst.mockResolvedValue({ id: 'builder-member-1' });
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalledWith({
      data: [
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP5',
          circleID: null,
          sortOrder: 0,
        },
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'NEW_USER',
          systemVariant: 'NEW_USER',
          circleID: null,
          sortOrder: 1,
        },
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'TOP_COLLABORATOR',
          systemVariant: 'TOP_COLLABORATOR_3',
          circleID: null,
          sortOrder: 2,
        },
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'VERIFIED_PROFILE',
          systemVariant: 'VERIFIED_PROFILE',
          circleID: null,
          sortOrder: 3,
        },
        {
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'CIRCLE_BUILDER',
          systemVariant: 'CIRCLE_BUILDER',
          circleID: null,
          sortOrder: 4,
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
          systemVariant: 'VIP5',
          title: 'VIP5',
        }),
        expect.objectContaining({
          type: 'SYSTEM',
          systemKey: 'NEW_USER',
          title: '新手',
        }),
        expect.objectContaining({
          type: 'SYSTEM',
          systemKey: 'TOP_COLLABORATOR',
          systemVariant: 'TOP_COLLABORATOR_3',
          title: '合作达人3',
          recognitionCount: 10_000,
        }),
        expect.objectContaining({
          type: 'SYSTEM',
          systemKey: 'VERIFIED_PROFILE',
          title: '资料可信',
        }),
        expect.objectContaining({
          type: 'SYSTEM',
          systemKey: 'CIRCLE_BUILDER',
          title: '圈子建设者',
        }),
      ]),
    );
  });

  it('broadcasts user profile summary after updating display icons', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
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
        systemVariant: 'VIP2',
        sortOrder: 0,
      } as any,
    ]);

    expect(
      realtimeService.invalidateUserProfileSummaryCache,
    ).toHaveBeenCalledWith('user-1');
    // Invalidate must run before the broadcast so a client refetch reads fresh.
    expect(
      realtimeService.invalidateUserProfileSummaryCache.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      realtimeService.broadcastUserProfileSummary.mock.invocationCallOrder[0],
    );
    expect(realtimeService.broadcastUserProfileSummary).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('wraps updateDisplayIcons delete+create in a transaction', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
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
        systemVariant: 'VIP1',
        sortOrder: 0,
      } as any,
      {
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP2',
        sortOrder: 1,
      } as any,
    ]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.userDisplayIcon.deleteMany).toHaveBeenCalled();
    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalled();
    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          systemKey: 'VIP',
          systemVariant: 'VIP1',
        }),
        expect.objectContaining({
          systemKey: 'VIP',
          systemVariant: 'VIP2',
        }),
      ]),
    });
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('maps legacy VIP selections without a variant to the highest eligible VIP badge', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
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

    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          systemKey: 'VIP',
          systemVariant: 'VIP5',
        }),
      ],
    });
  });

  it('rejects duplicate selections after legacy VIP variants are normalized', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
      createdAt: new Date(),
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);

    await expect(
      service.updateDisplayIcons('user-1', [
        {
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          sortOrder: 0,
        } as any,
        {
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP5',
          sortOrder: 1,
        } as any,
      ]),
    ).rejects.toThrow('Duplicate icon selection');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('caches getDisplayIconsForUser results within the TTL window', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 5,
      receivedLikeCount: 0,
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
      receivedLikeCount: 0,
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
        systemVariant: 'VIP5',
        sortOrder: 0,
      } as any,
    ]);
    prisma.user.findUnique.mockClear();

    await service.getDisplayIconsForUser('user-1');

    // Cache was invalidated by updateDisplayIcons, so the next read hits DB.
    expect(prisma.user.findUnique).toHaveBeenCalled();
  });

  it('awards the TOP_COLLABORATOR badge once recognition crosses the threshold', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 100,
      createdAt: new Date(0), // old account → no NEW_USER badge
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemKey: 'TOP_COLLABORATOR',
          title: '合作达人1',
          recognitionCount: 100,
        }),
      ]),
    );
  });

  it('does NOT award TOP_COLLABORATOR below the threshold', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 99,
      createdAt: new Date(0),
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemKey: 'TOP_COLLABORATOR' }),
      ]),
    );
  });

  it('awards VERIFIED_PROFILE when a public contact method is available', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 0,
      createdAt: new Date(0),
      status: 'ACTIVE',
      wechat: 'wxid_user1',
      qq: null,
      phoneNumber: null,
      privacySetting: {
        showPhone: false,
        showWechat: true,
        showQQ: true,
      },
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemKey: 'VERIFIED_PROFILE',
          title: '资料可信',
        }),
      ]),
    );
  });

  describe('getDisplayIconsForUsers (batch)', () => {
    it('resolves many users with a single batched set of queries and no writes', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          vipLevel: 2,
          receivedLikeCount: 0,
          createdAt: new Date(0),
          status: 'ACTIVE',
          iconPreferencesInitialized: true,
        },
        {
          id: 'user-2',
          vipLevel: 0,
          receivedLikeCount: 0,
          createdAt: new Date(0),
          status: 'ACTIVE',
          iconPreferencesInitialized: true,
        },
      ]);
      prisma.circleMember.findMany.mockResolvedValue([]);
      prisma.userDisplayIcon.findMany.mockResolvedValue([
        {
          id: 'display-1',
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP2',
          circleID: null,
          sortOrder: 0,
        },
      ]);

      const result = await service.getDisplayIconsForUsers([
        'user-1',
        'user-2',
        'user-1',
      ]);

      // One user fetch and one selections fetch for the whole batch — not per user.
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.userDisplayIcon.findMany).toHaveBeenCalledTimes(1);
      // Read-only: viewing others' badges must never persist prune/default writes.
      expect(prisma.userDisplayIcon.deleteMany).not.toHaveBeenCalled();
      expect(prisma.userDisplayIcon.createMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();

      expect(result.get('user-1')).toEqual([
        expect.objectContaining({ systemKey: 'VIP', systemVariant: 'VIP2' }),
      ]);
      // Initialized user with no selections shows nothing (no in-memory defaults).
      expect(result.get('user-2')).toEqual([]);
    });

    it('returns an empty array for requested ids that do not exist', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.circleMember.findMany.mockResolvedValue([]);
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);

      const result = await service.getDisplayIconsForUsers(['ghost']);

      expect(result.get('ghost')).toEqual([]);
    });

    it('serves cached entries without issuing new queries', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        vipLevel: 5,
        receivedLikeCount: 0,
        createdAt: new Date(),
        iconPreferencesInitialized: true,
      });
      prisma.circleMember.findMany.mockResolvedValue([]);
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);

      // Warm the cache through the single-user path.
      await service.getDisplayIconsForUser('user-1');
      prisma.user.findMany.mockClear();

      const result = await service.getDisplayIconsForUsers(['user-1']);

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(result.has('user-1')).toBe(true);
    });
  });

  it('awards CIRCLE_BUILDER for active owners or admins of mature circles', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 0,
      createdAt: new Date(0),
      status: 'ACTIVE',
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.circleMember.findFirst.mockResolvedValue({ id: 'builder-member-1' });
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systemKey: 'CIRCLE_BUILDER',
          title: '圈子建设者',
        }),
      ]),
    );
  });
});
