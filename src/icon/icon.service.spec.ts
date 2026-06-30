import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from './icon.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';

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
    collaborationRecognition: {
      groupBy: jest.fn(),
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

  const privacySettings = {
    getSettings: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: no distinct recognizers (groupBy returns one row per recognizer).
    prisma.collaborationRecognition.groupBy.mockResolvedValue([]);
    privacySettings.getSettings.mockResolvedValue({
      showPhone: false,
      showWechat: true,
      showQQ: true,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IconService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
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

  it('returns first-release badge system icons when their simple eligibility rules are met', async () => {
    const now = Date.now();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 3,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      iconPreferencesInitialized: true,
      avatarUrl: 'https://cdn.example/avatar.png',
      nickname: 'Builder User',
      city: 'Shanghai',
      email: 'builder@example.com',
      phoneNumber: '13800000000',
      wechat: null,
      qq: null,
      persona: 'I build useful circles',
      helloWords: null,
      whatsup: null,
      status: 'ACTIVE',
    });
    privacySettings.getSettings.mockResolvedValue({
      showPhone: true,
      showWechat: false,
      showQQ: false,
    });
    // 1000 DISTINCT recognizers (one groupBy row each)
    prisma.collaborationRecognition.groupBy.mockResolvedValue(
      Array.from({ length: 1000 }, (_unused, index) => ({
        recognizerID: `recognizer-${index}`,
      })),
    );
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        role: 'ADMIN',
        circle: {
          id: 'circle-1',
          name: 'Serious Builders',
          createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
          deleted: false,
          memberCount: 101,
          currentIconAsset: null,
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');
    const systemKeys = result.systemIcons.map((icon) => icon.systemKey);

    expect(systemKeys).toEqual(
      expect.arrayContaining([
        'VIP',
        'TOP_COLLABORATOR',
        'VERIFIED_PROFILE',
        'CIRCLE_BUILDER',
      ]),
    );
    expect(
      result.systemIcons.find((icon) => icon.systemKey === 'TOP_COLLABORATOR'),
    ).toEqual(
      expect.objectContaining({
        title: 'Top Collaborator',
        recognitionCount: 1000,
      }),
    );
  });

  it('does not grant Circle Builder when the managed circle has exactly 100 members', async () => {
    const now = Date.now();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      iconPreferencesInitialized: true,
      status: 'ACTIVE',
    });
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        role: 'OWNER',
        circle: {
          id: 'circle-1',
          name: 'Almost There',
          createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
          deleted: false,
          memberCount: 100,
          currentIconAsset: null,
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons.map((icon) => icon.systemKey)).not.toContain(
      'CIRCLE_BUILDER',
    );
  });

  it('does not grant Verified Profile without a public contact method', async () => {
    const now = Date.now();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      iconPreferencesInitialized: true,
      avatarUrl: 'https://cdn.example/avatar.png',
      nickname: 'Private User',
      city: 'Shanghai',
      email: 'private@example.com',
      phoneNumber: '13800000000',
      wechat: 'wxid_private',
      qq: '10001',
      persona: 'I keep my contacts private',
      helloWords: null,
      whatsup: null,
      status: 'ACTIVE',
    });
    privacySettings.getSettings.mockResolvedValue({
      showPhone: false,
      showWechat: false,
      showQQ: false,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons.map((icon) => icon.systemKey)).not.toContain(
      'VERIFIED_PROFILE',
    );
  });

  describe('Verified Profile required-field matrix', () => {
    const now = Date.now();
    const fullyEligibleUser = () => ({
      id: 'user-1',
      vipLevel: 0,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      iconPreferencesInitialized: true,
      avatarUrl: 'https://cdn.example/avatar.png',
      nickname: 'Complete User',
      city: 'Shanghai',
      email: 'complete@example.com',
      phoneNumber: '13800000000',
      wechat: null,
      qq: null,
      persona: 'I build useful circles',
      helloWords: null,
      whatsup: null,
      status: 'ACTIVE',
    });

    beforeEach(() => {
      privacySettings.getSettings.mockResolvedValue({
        showPhone: true,
        showWechat: false,
        showQQ: false,
      });
      prisma.circleMember.findMany.mockResolvedValue([]);
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);
    });

    it('grants Verified Profile when every requirement is met', async () => {
      prisma.user.findUnique.mockResolvedValue(fullyEligibleUser());
      const result = await service.getIconOptions('user-1');
      expect(result.systemIcons.map((i) => i.systemKey)).toContain(
        'VERIFIED_PROFILE',
      );
    });

    it.each([
      ['avatarUrl', { avatarUrl: null }],
      ['nickname', { nickname: '  ' }],
      ['city', { city: null }],
      ['email', { email: null }],
      ['bio too short', { persona: 'short' }],
      ['inactive status', { status: 'BANNED' }],
    ])(
      'withholds Verified Profile when %s is missing/invalid',
      async (_label, override) => {
        prisma.user.findUnique.mockResolvedValue({
          ...fullyEligibleUser(),
          ...override,
        });
        const result = await service.getIconOptions('user-1');
        expect(result.systemIcons.map((i) => i.systemKey)).not.toContain(
          'VERIFIED_PROFILE',
        );
      },
    );
  });

  it('counts distinct recognizers, so one author cannot inflate the badge by repeat recognitions', async () => {
    const now = Date.now();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      iconPreferencesInitialized: true,
      status: 'ACTIVE',
    });
    // groupBy collapses many recognitions from the same authors into one row
    // each: only 2 distinct recognizers → far below the 100 threshold.
    prisma.collaborationRecognition.groupBy.mockResolvedValue([
      { recognizerID: 'author-a' },
      { recognizerID: 'author-b' },
    ]);
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(prisma.collaborationRecognition.groupBy).toHaveBeenCalledWith({
      by: ['recognizerID'],
      where: { recipientID: 'user-1', revokedAt: null },
    });
    expect(result.systemIcons.map((i) => i.systemKey)).not.toContain(
      'TOP_COLLABORATOR',
    );
  });

  it('grants Circle Builder for a >100-member circle at least 7 days old', async () => {
    const now = Date.now();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      iconPreferencesInitialized: true,
      status: 'ACTIVE',
    });
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        role: 'OWNER',
        circle: {
          id: 'circle-1',
          name: 'Big Circle',
          createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
          deleted: false,
          memberCount: 101,
          currentIconAsset: null,
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons.map((i) => i.systemKey)).toContain(
      'CIRCLE_BUILDER',
    );
  });

  it('broadcasts user profile summary after updating display icons', async () => {
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

  it('awards the PARTNER (合作达人) badge once receivedLikeCount crosses the threshold', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 5, // >= PARTNER_LIKE_THRESHOLD (3)
      createdAt: new Date(0), // old account → no NEW_USER badge
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemKey: 'PARTNER', title: '合作达人' }),
      ]),
    );
  });

  it('does NOT award PARTNER below the threshold', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      vipLevel: 0,
      receivedLikeCount: 2, // below threshold
      createdAt: new Date(0),
      iconPreferencesInitialized: true,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.systemIcons).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemKey: 'PARTNER' }),
      ]),
    );
  });
});
