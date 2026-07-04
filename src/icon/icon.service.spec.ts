import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { IconService } from './icon.service';

// Privacy defaults mirror PrivacySettingsService: phone hidden, wechat/qq shown.
const DEFAULT_PRIVACY = {
  showPhone: false,
  showWechat: true,
  showQQ: true,
} as any;

// A user row that satisfies the strict Verified Profile rule (complete profile
// + a shown contact method). Override fields per test.
const verifiedUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  vipLevel: 0,
  receivedLikeCount: 0,
  createdAt: new Date(0),
  status: 'ACTIVE',
  avatarUrl: 'https://cdn/a.png',
  nickname: 'Alice',
  city: 'Shanghai',
  email: 'a@example.com',
  phoneNumber: null,
  wechat: 'wxid_alice',
  qq: null,
  persona: 'A reasonably long self-introduction.',
  helloWords: null,
  whatsup: null,
  iconPreferencesInitialized: true,
  ...overrides,
});

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
    getSettingsForUsers: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Sensible defaults: no circles, no likes, default privacy.
    prisma.circleMember.findMany.mockResolvedValue([]);
    privacySettings.getSettings.mockResolvedValue({ ...DEFAULT_PRIVACY });
    privacySettings.getSettingsForUsers.mockResolvedValue(new Map());

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

  it('returns every VIP variant up to the current level as selectable options', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 5 }));
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
          variant: icon.systemVariant,
          selected: icon.selected,
        })),
    ).toEqual([
      { variant: 'VIP1', selected: false },
      { variant: 'VIP2', selected: false },
      { variant: 'VIP3', selected: true },
      { variant: 'VIP4', selected: false },
      { variant: 'VIP5', selected: false },
    ]);
  });

  it('maps a legacy VIP placeholder variant to the highest eligible VIP badge', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 5 }));
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
      expect.objectContaining({ systemKey: 'VIP', systemVariant: 'VIP5' }),
    ]);
  });

  it('awards Top Collaborator tiers by received like count', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ receivedLikeCount: 1000 }),
    );
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons
        .filter((icon) => icon.systemKey === 'TOP_COLLABORATOR')
        .map((icon) => icon.systemVariant),
    ).toEqual(['TOP_COLLABORATOR_1', 'TOP_COLLABORATOR_2']);
  });

  it('does NOT award Top Collaborator below the first like threshold', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ receivedLikeCount: 99 }),
    );
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons.some((icon) => icon.systemKey === 'TOP_COLLABORATOR'),
    ).toBe(false);
  });

  it('awards Verified Profile only when the profile is complete and a contact is public', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser());
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons.some((icon) => icon.systemKey === 'VERIFIED_PROFILE'),
    ).toBe(true);
  });

  it('withholds Verified Profile when a required field is missing', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons.some((icon) => icon.systemKey === 'VERIFIED_PROFILE'),
    ).toBe(false);
  });

  it('withholds Verified Profile when the only contact method is hidden by privacy', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ wechat: null, qq: null, phoneNumber: '13800138000' }),
    );
    // phone present but showPhone defaults to false → no public contact.
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons.some((icon) => icon.systemKey === 'VERIFIED_PROFILE'),
    ).toBe(false);
  });

  it('awards Circle Builder for an owner/admin of a mature, >100-member circle', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
    prisma.circleMember.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        circleID: 'circle-1',
        role: 'OWNER',
        circle: {
          id: 'circle-1',
          name: 'Big Circle',
          createdAt: new Date(0),
          deleted: false,
          memberCount: 250,
          currentIconAsset: null,
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons.some((icon) => icon.systemKey === 'CIRCLE_BUILDER'),
    ).toBe(true);
  });

  it('does NOT award Circle Builder for a circle at the member threshold', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
    prisma.circleMember.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        circleID: 'circle-1',
        role: 'OWNER',
        circle: {
          id: 'circle-1',
          name: 'Exactly 100',
          createdAt: new Date(0),
          deleted: false,
          memberCount: 100,
          currentIconAsset: null,
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(
      result.systemIcons.some((icon) => icon.systemKey === 'CIRCLE_BUILDER'),
    ).toBe(false);
  });

  it('exposes circle icons for circles that have a current icon asset', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
    prisma.circleMember.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        circleID: 'circle-1',
        role: 'MEMBER',
        circle: {
          id: 'circle-1',
          name: 'Nbuuhbub',
          createdAt: new Date(),
          deleted: false,
          memberCount: 3,
          currentIconAsset: {
            id: 'asset-1',
            imageUrl: 'http://cdn/circle.png',
          },
        },
      },
    ]);
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    const result = await service.getIconOptions('user-1');

    expect(result.circleIcons).toEqual([
      expect.objectContaining({ circleId: 'circle-1', title: 'Nbuuhbub' }),
    ]);
  });

  it('auto-initializes default system icons for legacy users without preferences', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ vipLevel: 2, iconPreferencesInitialized: false }),
    );
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    await service.getIconOptions('user-1');

    expect(prisma.userDisplayIcon.createMany).toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { iconPreferencesInitialized: true },
    });
  });

  it('wraps updateDisplayIcons delete+create in one transaction and broadcasts after invalidating', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 5 }));
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({ count: 1 });
    prisma.userDisplayIcon.createMany.mockResolvedValue({ count: 2 });
    prisma.user.update.mockResolvedValue({ id: 'user-1' });

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
    expect(
      realtimeService.invalidateUserProfileSummaryCache.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      realtimeService.broadcastUserProfileSummary.mock.invocationCallOrder[0],
    );
  });

  it('rejects duplicate variant selections in updateDisplayIcons', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 5 }));

    await expect(
      service.updateDisplayIcons('user-1', [
        {
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP1',
          sortOrder: 0,
        } as any,
        {
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP1',
          sortOrder: 1,
        } as any,
      ]),
    ).rejects.toThrow('Duplicate icon selection');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  describe('getDisplayIconsForUsers (batch)', () => {
    it('resolves many users with batched queries and no writes', async () => {
      prisma.user.findMany.mockResolvedValue([
        verifiedUser({ id: 'user-1', vipLevel: 2, email: null }),
        verifiedUser({ id: 'user-2', vipLevel: 0, email: null }),
      ]);
      privacySettings.getSettingsForUsers.mockResolvedValue(
        new Map([
          ['user-1', { ...DEFAULT_PRIVACY }],
          ['user-2', { ...DEFAULT_PRIVACY }],
        ]),
      );
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

      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(privacySettings.getSettingsForUsers).toHaveBeenCalledTimes(1);
      // Read-only: never persists prune/default writes for viewed users.
      expect(prisma.userDisplayIcon.deleteMany).not.toHaveBeenCalled();
      expect(prisma.userDisplayIcon.createMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();

      expect(result.get('user-1')).toEqual([
        expect.objectContaining({ systemKey: 'VIP', systemVariant: 'VIP2' }),
      ]);
      expect(result.get('user-2')).toEqual([]);
    });

    it('returns an empty array for requested ids that do not exist', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);
      privacySettings.getSettingsForUsers.mockResolvedValue(new Map());

      const result = await service.getDisplayIconsForUsers(['ghost']);

      expect(result.get('ghost')).toEqual([]);
    });
  });

  it('caches getDisplayIconsForUser results within the TTL window', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    await service.getDisplayIconsForUser('user-1');
    const callsAfterFirst = prisma.user.findUnique.mock.calls.length;
    await service.getDisplayIconsForUser('user-1');
    await service.getDisplayIconsForUser('user-1');

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(callsAfterFirst);
  });
});
