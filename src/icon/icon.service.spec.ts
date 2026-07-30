import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { RedisService } from 'src/redis/redis.service';
import {
  IconService,
  MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS,
} from './icon.service';

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
  vipExpiresAt: null,
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
    $queryRaw: jest.fn(),
    $transaction: jest.fn((fn: (tx: any) => Promise<any>) => fn(prisma)),
  };

  // Eligibility memberships load in two steps: $queryRaw picks the ids that
  // survive the per-user cap, then circleMember.findMany hydrates them.
  const mockMemberships = (
    memberships: Array<Record<string, unknown> & { id?: string }>,
  ) => {
    const rows = memberships.map((membership, index) => ({
      id: membership.id ?? `member-${index}`,
      ...membership,
    }));
    prisma.$queryRaw.mockResolvedValue(rows.map(({ id }) => ({ id })));
    prisma.circleMember.findMany.mockResolvedValue(rows);
  };

  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(() => Promise.resolve()),
  };

  const privacySettings = {
    getSettings: jest.fn(),
    getSettingsForUsers: jest.fn(),
  };

  const redisService = {
    isEnabled: jest.fn(() => true),
    publish: jest.fn(() => Promise.resolve(true)),
    subscribePattern: jest.fn(() => Promise.resolve(true)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Sensible defaults: no circles, no likes, default privacy.
    mockMemberships([]);
    privacySettings.getSettings.mockResolvedValue({ ...DEFAULT_PRIVACY });
    privacySettings.getSettingsForUsers.mockResolvedValue(new Map());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IconService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get(IconService);
  });

  it('returns only the effective super badge for a legacy level 5 user', async () => {
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

    // The persisted VIP3 selection carries forward to the user's current
    // effective tier (VIP4) rather than being dropped as stale — a VIP display
    // choice must follow tier changes, not vanish.
    expect(
      result.systemIcons
        .filter((icon) => icon.systemKey === 'VIP')
        .map((icon) => ({
          variant: icon.systemVariant,
          selected: icon.selected,
        })),
    ).toEqual([{ variant: 'VIP4', selected: true }]);
  });

  it('maps a legacy VIP placeholder variant to the highest eligible VIP badge', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 4 }));
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
        systemVariant: 'VIP4',
        title: '超级会员',
      }),
    ]);
  });

  it('migrates a persisted VIP5 selection to the current super badge', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 5 }));
    prisma.userDisplayIcon.findMany.mockResolvedValue([
      {
        id: 'display-vip-5',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP5',
        circleID: null,
        sortOrder: 0,
      },
    ]);

    const result = await service.getIconOptions('user-1');

    expect(prisma.userDisplayIcon.deleteMany).not.toHaveBeenCalled();
    expect(result.displayIcons).toEqual([
      expect.objectContaining({ systemKey: 'VIP', systemVariant: 'VIP4' }),
    ]);
  });

  it('does not emit a persisted membership badge after expiry', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T12:00:00.000Z').getTime());
    try {
      prisma.user.findUnique.mockResolvedValue(
        verifiedUser({
          vipLevel: 3,
          vipExpiresAt: new Date('2026-07-22T12:00:00.000Z'),
        }),
      );
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

      await expect(service.getDisplayIconsForUser('user-1')).resolves.toEqual(
        [],
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reuse a cached membership badge across its expiry boundary', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T11:59:59.999Z').getTime());
    try {
      const expiringUser = verifiedUser({
        vipLevel: 1,
        vipExpiresAt: new Date('2026-07-22T12:00:00.000Z'),
      });
      prisma.user.findUnique.mockResolvedValue(expiringUser);
      prisma.userDisplayIcon.findMany.mockResolvedValue([
        {
          id: 'display-vip-1',
          userID: 'user-1',
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP1',
          circleID: null,
          sortOrder: 0,
        },
      ]);

      await expect(service.getDisplayIconsForUser('user-1')).resolves.toEqual([
        expect.objectContaining({ systemVariant: 'VIP1' }),
      ]);

      jest.setSystemTime(new Date('2026-07-22T12:00:00.000Z').getTime());

      await expect(service.getDisplayIconsForUser('user-1')).resolves.toEqual(
        [],
      );
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
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
    mockMemberships([
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
    mockMemberships([
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
    mockMemberships([
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

  it('auto-initializes only the highest Top Collaborator tier', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({
        receivedLikeCount: 10_000,
        iconPreferencesInitialized: false,
      }),
    );
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    await service.getIconOptions('user-1');

    const created = prisma.userDisplayIcon.createMany.mock.calls[0][0].data;
    expect(
      created.filter(
        (item: { systemKey: string }) => item.systemKey === 'TOP_COLLABORATOR',
      ),
    ).toEqual([
      expect.objectContaining({
        systemVariant: 'TOP_COLLABORATOR_3',
      }),
    ]);
  });

  it('wraps updateDisplayIcons delete+create in one transaction and broadcasts after invalidating', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 4 }));
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({ count: 1 });
    prisma.userDisplayIcon.createMany.mockResolvedValue({ count: 2 });
    prisma.user.update.mockResolvedValue({ id: 'user-1' });

    await service.updateDisplayIcons('user-1', [
      {
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP4',
        sortOrder: 0,
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
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ vipLevel: 4 }));

    await expect(
      service.updateDisplayIcons('user-1', [
        {
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP4',
          sortOrder: 0,
        } as any,
        {
          displayType: 'SYSTEM',
          systemKey: 'VIP',
          systemVariant: 'VIP4',
          sortOrder: 1,
        } as any,
      ]),
    ).rejects.toThrow('Duplicate icon selection');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects multiple tiers of the same leveled badge type', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ receivedLikeCount: 1_000 }),
    );

    await expect(
      service.updateDisplayIcons('user-1', [
        {
          displayType: 'SYSTEM',
          systemKey: 'TOP_COLLABORATOR',
          systemVariant: 'TOP_COLLABORATOR_1',
          sortOrder: 0,
        } as any,
        {
          displayType: 'SYSTEM',
          systemKey: 'TOP_COLLABORATOR',
          systemVariant: 'TOP_COLLABORATOR_2',
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

    // Regression: the batch path used to read every membership of every author
    // with no cap, so one power user could drag a whole feed page down.
    it('caps memberships per user instead of per query', async () => {
      prisma.user.findMany.mockResolvedValue([
        verifiedUser({ id: 'user-1', email: null }),
      ]);
      privacySettings.getSettingsForUsers.mockResolvedValue(
        new Map([['user-1', { ...DEFAULT_PRIVACY }]]),
      );
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);
      mockMemberships([]);

      await service.getDisplayIconsForUsers(['user-1', 'user-2']);

      const [sql, ...params] = prisma.$queryRaw.mock.calls[0];
      const cap = params.at(-1);
      expect(sql.join('?')).toContain('PARTITION BY');
      expect(cap).toBe(MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS);
      // Hydration is keyed by the capped ids, never by an unbounded user scan.
      expect(prisma.circleMember.findMany).not.toHaveBeenCalled();
    });

    it('prioritizes persisted circle selections before applying the membership cap', async () => {
      prisma.user.findMany.mockResolvedValue([
        verifiedUser({ id: 'user-1', email: null }),
      ]);
      privacySettings.getSettingsForUsers.mockResolvedValue(
        new Map([['user-1', { ...DEFAULT_PRIVACY }]]),
      );
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);
      mockMemberships([]);

      await service.getDisplayIconsForUsers(['user-1']);

      const [sql] = prisma.$queryRaw.mock.calls[0];
      const query = sql.join('?');
      expect(query).toContain('LEFT JOIN "UserDisplayIcon" selection');
      expect(query).toContain('(selection."id" IS NOT NULL) DESC');
    });

    it('prioritizes a qualifying circle-builder membership before applying the cap', async () => {
      prisma.user.findMany.mockResolvedValue([
        verifiedUser({ id: 'user-1', email: null }),
      ]);
      privacySettings.getSettingsForUsers.mockResolvedValue(
        new Map([['user-1', { ...DEFAULT_PRIVACY }]]),
      );
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);
      mockMemberships([]);

      await service.getDisplayIconsForUsers(['user-1']);

      const [sql] = prisma.$queryRaw.mock.calls[0];
      const query = sql.join('?');
      expect(query).toContain("member.\"role\" IN ('OWNER', 'ADMIN')");
      expect(query).toContain('circle."memberCount" >');
    });

    it('applies the same cap on the single-user path', async () => {
      prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
      prisma.userDisplayIcon.findMany.mockResolvedValue([]);
      mockMemberships([
        {
          id: 'member-a',
          userID: 'user-1',
          circleID: 'circle-1',
          role: 'MEMBER',
          circle: {
            id: 'circle-1',
            name: 'C',
            createdAt: new Date(),
            deleted: false,
            memberCount: 3,
            currentIconAsset: null,
          },
        },
      ]);

      await service.getDisplayIconsForUser('user-1');

      const [, ...params] = prisma.$queryRaw.mock.calls[0];
      const cap = params.at(-1);
      expect(cap).toBe(MAX_ELIGIBILITY_CIRCLE_MEMBERSHIPS);
      expect(prisma.circleMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['member-a'] } } }),
      );
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

  it('evicts locally and fans out cross-instance on invalidateDisplayIconCacheFor', async () => {
    prisma.user.findUnique.mockResolvedValue(verifiedUser({ email: null }));
    prisma.userDisplayIcon.findMany.mockResolvedValue([]);

    // Warm the cache (e.g. a VIP1 badge), then invalidate as a grant would.
    await service.getDisplayIconsForUser('user-1');
    const callsAfterWarm = prisma.user.findUnique.mock.calls.length;

    service.invalidateDisplayIconCacheFor('user-1');

    // Fans the eviction out so every other instance drops its stale copy too.
    expect(redisService.publish).toHaveBeenCalledWith(
      'circle:icon:display-invalidate',
      'user-1',
    );
    // Local entry is gone: the next read recomputes rather than serving stale.
    await service.getDisplayIconsForUser('user-1');
    expect(prisma.user.findUnique.mock.calls.length).toBeGreaterThan(
      callsAfterWarm,
    );
  });

  it('carries a persisted VIP1 selection forward to VIP2 after an upgrade', async () => {
    // Prefs already initialized, so defaults won't re-add anything; the saved
    // VIP1 row must follow the upgrade to VIP2 instead of being dropped stale.
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ vipLevel: 2, iconPreferencesInitialized: true }),
    );
    prisma.userDisplayIcon.findMany.mockResolvedValue([
      {
        id: 'display-vip-1',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP1',
        circleID: null,
        sortOrder: 0,
      },
    ]);

    const options = await service.getIconOptions('user-1');
    expect(
      options.systemIcons
        .filter((icon) => icon.systemKey === 'VIP')
        .map((icon) => ({
          variant: icon.systemVariant,
          selected: icon.selected,
        })),
    ).toEqual([{ variant: 'VIP2', selected: true }]);

    // And the displayed badge (feeds / profile / auth-me path) shows VIP2.
    const displayed = await service.getDisplayIconsForUser('user-1');
    const vip = displayed.filter((icon) => icon.systemKey === 'VIP');
    expect(vip).toHaveLength(1);
    expect(vip[0].systemVariant).toBe('VIP2');
  });

  it('collapses historical VIP tier selections into one current membership badge', async () => {
    prisma.user.findUnique.mockResolvedValue(
      verifiedUser({ vipLevel: 3, iconPreferencesInitialized: true }),
    );
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
      {
        id: 'display-vip-1',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP1',
        circleID: null,
        sortOrder: 2,
      },
      {
        id: 'display-vip-2',
        userID: 'user-1',
        displayType: 'SYSTEM',
        systemKey: 'VIP',
        systemVariant: 'VIP2',
        circleID: null,
        sortOrder: 3,
      },
    ]);

    const displayed = await service.getDisplayIconsForUser('user-1');

    expect(displayed).toEqual([
      expect.objectContaining({
        id: 'system:VIP3',
        systemKey: 'VIP',
        systemVariant: 'VIP3',
        sortOrder: 0,
      }),
    ]);
  });

  it('retries the display-icon subscription with backoff until Redis accepts it', async () => {
    jest.useFakeTimers();
    try {
      const flakyRedis = {
        isEnabled: jest.fn(() => true),
        publish: jest.fn(() => Promise.resolve(true)),
        subscribePattern: jest
          .fn()
          .mockResolvedValueOnce(false) // Redis unavailable at boot
          .mockResolvedValueOnce(true), // recovered on the retry
      };
      const svc = new IconService(
        prisma as never,
        realtimeService as never,
        privacySettings as never,
        flakyRedis as never,
      );

      await svc.onModuleInit();
      expect(flakyRedis.subscribePattern).toHaveBeenCalledTimes(1);

      // Backoff fires and re-subscribes once Redis is back.
      await jest.advanceTimersByTimeAsync(1_000);
      expect(flakyRedis.subscribePattern).toHaveBeenCalledTimes(2);

      // Once active it stops retrying — no unbounded re-subscribe loop.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(flakyRedis.subscribePattern).toHaveBeenCalledTimes(2);

      svc.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
