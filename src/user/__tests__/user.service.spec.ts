import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { ConfigService } from '@nestjs/config';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { UserStatus } from 'src/generated/prisma';
import { UserService } from '../user.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from 'src/icon/icon.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { AvatarFrameService } from 'src/avatar-frame/avatar-frame.service';

describe('UserService', () => {
  let service: UserService;
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userLike: {
      findUnique: jest.fn(),
    },
    accountIdentifier: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (operation: any) => operation(prisma)),
  };
  const refreshTokens = {
    revokeAll: jest.fn().mockResolvedValue(undefined),
  };
  const configGet = jest.fn(() => null);
  const iconService = {
    getDisplayIconsForUser: jest.fn(() => Promise.resolve([])),
  };
  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(() => Promise.resolve()),
  };
  const privacySettings = {
    canViewProfileField: jest.fn(),
    getSettings: jest.fn().mockResolvedValue({ addMeByAccount: true }),
  };
  const avatarFrames = {
    resolvePublicAppearances: jest.fn(),
  };

  async function buildService(
    overrides: { configGet?: (key: string) => string | null } = {},
  ): Promise<UserService> {
    const getter = overrides.configGet ?? configGet;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: getter } },
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: IconService, useValue: iconService },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: AvatarFrameService, useValue: avatarFrames },
      ],
    }).compile();
    return module.get<UserService>(UserService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    privacySettings.canViewProfileField.mockResolvedValue(true);
    // clearAllMocks 只清调用记录、不清实现，逐个用例覆盖过的返回值会漏给下一个。
    privacySettings.getSettings.mockResolvedValue({ addMeByAccount: true });
    prisma.userLike.findUnique.mockResolvedValue(null);
    prisma.accountIdentifier.findUnique.mockResolvedValue(null);
    // 邀请码分配改成批量候选查询：默认没有任何候选被占用。
    prisma.user.findMany.mockResolvedValue([]);
    prisma.accountIdentifier.findMany.mockResolvedValue([]);
    avatarFrames.resolvePublicAppearances.mockResolvedValue(new Map());
    service = await buildService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getVipLevels', () => {
    it('maps existing user ids to their vipLevel and dedupes the query', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'a', vipLevel: 3 },
        { id: 'b', vipLevel: 0 },
      ]);

      const result = await service.getVipLevels(['a', 'b', 'a', 'missing']);

      // Missing ids are simply absent (client defaults them to 0); query is deduped.
      expect(result).toEqual({ a: 3, b: 0 });
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b', 'missing'] } },
        select: { id: true, vipLevel: true, vipExpiresAt: true },
      });
    });

    it('short-circuits on empty input without hitting the database', async () => {
      const result = await service.getVipLevels([]);

      expect(result).toEqual({});
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('resolves hyphenless OpenIM sendIDs to UUID users and keys by the caller id', async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      const imId = '11111111222233334444555555555555'; // = toImUserId(uuid)
      prisma.user.findMany.mockResolvedValue([{ id: uuid, vipLevel: 4 }]);

      const result = await service.getVipLevels([imId]);

      // 查询用还原后的 UUID(否则聊天场景的无连字符 id 全部落空、VIP 默认 0);
      // 响应键用调用方传入的原始 id,前端按当初传的原样查回。
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [uuid] } },
        select: { id: true, vipLevel: true, vipExpiresAt: true },
      });
      expect(result).toEqual({ [imId]: 4 });
    });

    it('returns every requested alias when both UUID and OpenIM forms of one user are sent', async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      const imId = '11111111222233334444555555555555';
      prisma.user.findMany.mockResolvedValue([{ id: uuid, vipLevel: 4 }]);

      const result = await service.getVipLevels([uuid, imId]);

      // 归一后只查一次(同一 UUID),但两种别名都要回——否则用另一形态的一侧会默认 VIP0。
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [uuid] } },
        select: { id: true, vipLevel: true, vipExpiresAt: true },
      });
      expect(result).toEqual({ [uuid]: 4, [imId]: 4 });
    });

    it('resolves expiry so an expired paid level maps to 0', async () => {
      // Fixed past/future dates cross the expiry boundary against real `now`.
      const past = new Date('2020-01-01T00:00:00.000Z');
      const future = new Date('2999-01-01T00:00:00.000Z');
      prisma.user.findMany.mockResolvedValue([
        { id: 'expired', vipLevel: 3, vipExpiresAt: past },
        { id: 'active', vipLevel: 2, vipExpiresAt: future },
        { id: 'lifetime', vipLevel: 4, vipExpiresAt: null },
      ]);

      const result = await service.getVipLevels([
        'expired',
        'active',
        'lifetime',
      ]);

      // Expired paid level collapses to 0 (no leaked paid name effect); an
      // unexpired level is preserved; super (4) is lifetime regardless.
      expect(result).toEqual({ expired: 0, active: 2, lifetime: 4 });
    });
  });

  describe('getAppearances', () => {
    it('normalizes aliases once and returns every caller alias', async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      const imId = '11111111222233334444555555555555';
      const missingUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const appearance = {
        vipLevel: 3,
        avatarFrame: {
          id: 'frame-1',
          key: 'membership-diamond',
          name: 'Diamond frame',
          imageUrl: 'https://cdn.example/frame.png',
        },
      };
      avatarFrames.resolvePublicAppearances.mockResolvedValue(
        new Map([[uuid, appearance]]),
      );

      await expect(
        service.getAppearances([uuid, imId, uuid, missingUuid]),
      ).resolves.toEqual({
        [uuid]: appearance,
        [imId]: appearance,
      });
      expect(avatarFrames.resolvePublicAppearances).toHaveBeenCalledWith([
        uuid,
        missingUuid,
      ]);
    });

    it('short-circuits an empty appearance request', async () => {
      await expect(service.getAppearances([])).resolves.toEqual({});
      expect(avatarFrames.resolvePublicAppearances).not.toHaveBeenCalled();
    });

    it('omits malformed ids without sending them to the UUID query', async () => {
      const uuid = '11111111-2222-3333-4444-555555555555';
      avatarFrames.resolvePublicAppearances.mockResolvedValue(
        new Map([[uuid, { vipLevel: 0, avatarFrame: null }]]),
      );

      await expect(
        service.getAppearances(['not-a-user-id', uuid]),
      ).resolves.toEqual({
        [uuid]: { vipLevel: 0, avatarFrame: null },
      });
      expect(avatarFrames.resolvePublicAppearances).toHaveBeenCalledWith([
        uuid,
      ]);
    });
  });

  it('adds the effective frame appearance to a public profile', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      vipLevel: 0,
      vipExpiresAt: null,
      receivedLikeCount: 0,
    });
    avatarFrames.resolvePublicAppearances.mockResolvedValue(
      new Map([
        [
          'user-1',
          {
            vipLevel: 0,
            avatarFrame: {
              id: 'frame-1',
              key: 'admin-gift',
              name: 'Gift frame',
              imageUrl: null,
            },
          },
        ],
      ]),
    );

    await expect(service.findOne('user-1')).resolves.toMatchObject({
      avatarFrameAppearance: {
        id: 'frame-1',
        key: 'admin-gift',
        name: 'Gift frame',
        imageUrl: null,
      },
    });
    expect(avatarFrames.resolvePublicAppearances).toHaveBeenCalledWith([
      'user-1',
    ]);
  });

  it('creates an independent canonical invite code with an explicit account ID', async () => {
    prisma.user.create.mockResolvedValue({ id: 'user-1' });

    await service.create({
      accountId: 'Alice_01',
      password: 'password1',
      nickname: 'Alice',
    });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        accountId: 'Alice_01',
        inviteCode: expect.stringMatching(/^[A-Z0-9]{6}$/),
        passwordHash: expect.any(String),
        nickname: 'Alice',
      },
      select: expect.any(Object),
    });
  });

  it('returns the committed user when the optional avatar-frame lookup fails', async () => {
    prisma.user.create.mockResolvedValue({ id: 'user-1' });
    avatarFrames.resolvePublicAppearances.mockRejectedValue(
      new Error('database timeout'),
    );

    await expect(
      service.create({
        accountId: 'Alice_04',
        password: 'password1',
        nickname: 'Alice',
      }),
    ).resolves.toMatchObject({
      id: 'user-1',
      avatarFrameAppearance: null,
    });

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('returns service unavailable when admin-user invite-code collisions are exhausted', async () => {
    prisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['inviteCode'] },
      }),
    );

    await expect(
      service.create({
        accountId: 'Alice_02',
        password: 'password1',
        nickname: 'Alice',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.user.create).toHaveBeenCalledTimes(10);
  });

  it('does not retry when the explicit account ID is already taken', async () => {
    const accountIdCollision = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['accountId'] },
      },
    );
    prisma.user.create.mockRejectedValue(accountIdCollision);

    await expect(
      service.create({
        accountId: 'Alice_03',
        password: 'password1',
        nickname: 'Alice',
      }),
    ).rejects.toBe(accountIdCollision);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an account ID claimed by fancy-number inventory before creating an admin user', async () => {
    prisma.accountIdentifier.findUnique.mockResolvedValue({
      currentUserID: null,
      reservedForUserID: null,
      inviteOwnerUserID: null,
      fancyNumber: { id: 'fancy-1' },
    });

    await expect(
      service.create({
        accountId: 'ABC123',
        password: 'password1',
        nickname: 'Alice',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.accountIdentifier.findUnique).toHaveBeenCalledWith({
      where: { value: 'abc123' },
      select: {
        currentUserID: true,
        reservedForUserID: true,
        inviteOwnerUserID: true,
        fancyNumber: { select: { id: true } },
      },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('finds an active user by exact accountId without exposing admin pagination', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });

    await expect(
      service.findByExactAccountId(' jimmy '),
    ).resolves.toMatchObject({ id: 'user-1', accountId: 'jimmy' });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: { equals: 'jimmy', mode: 'insensitive' },
        status: 'ACTIVE',
      },
      select: expect.any(Object),
    });
  });

  it('returns null for empty accountId search keywords', async () => {
    await expect(service.findByExactAccountId('   ')).resolves.toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  // addMeByAccount 的收口点：关掉之后账号搜索就该查不到人，好友请求根本形不成。
  // 放在这里而不是发请求时判，是因为这条路径服务端无从证实来源 —— 只能在唯一
  // 能把账号号码变成 userID 的接口上拦。
  it('hides users who turned off account lookup, indistinguishably from not found', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-9',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });
    privacySettings.getSettings.mockResolvedValue({ addMeByAccount: false });

    await expect(
      service.findByExactAccountId('jimmy', 'viewer-1'),
    ).resolves.toBeNull();
  });

  // 自己搜自己不该被自己的设置挡住 —— 用户要能在资料页核对自己的账号号码。
  it('still returns the viewer to themselves when account lookup is off', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-9',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });
    privacySettings.getSettings.mockResolvedValue({ addMeByAccount: false });
    privacySettings.canViewProfileField.mockResolvedValue(true);
    avatarFrames.resolvePublicAppearances.mockResolvedValue(new Map());

    await expect(
      service.findByExactAccountId('jimmy', 'user-9'),
    ).resolves.toMatchObject({ id: 'user-9' });
  });

  it('applies the target profile-privacy gate to account search results (F-01)', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-9',
      accountId: 'jimmy',
      nickname: 'Jimmy',
      phoneNumber: '13800000000',
      wechat: 'wx-secret',
      qq: '10001',
    });
    // Target set wechat/qq to private; phone stays visible.
    privacySettings.canViewProfileField.mockImplementation(
      (_id: string, field: string) => Promise.resolve(field === 'phoneNumber'),
    );

    const result = await service.findByExactAccountId('jimmy', 'viewer-1');

    // Private contact fields are nulled even on the friend-add lookup — matching
    // GET /user/:id, so the search endpoint can't bypass the privacy toggle.
    expect(result).toMatchObject({
      id: 'user-9',
      wechat: null,
      qq: null,
      phoneNumber: '13800000000',
    });
    expect(privacySettings.canViewProfileField).toHaveBeenCalledWith(
      'user-9',
      'wechat',
      false,
      false,
    );
  });

  describe('findAll', () => {
    it('paginates with the supplied limit and skip', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
      prisma.user.count.mockResolvedValue(7);

      const result = await service.findAll({ page: 2, limit: 5 });

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: undefined,
        select: expect.any(Object),
        take: 5,
        skip: 5,
      });
      expect(prisma.user.count).toHaveBeenCalledWith({ where: undefined });
      expect(result).toEqual({
        data: [
          {
            id: 'user-1',
            avatarFrameAppearance: null,
            vipLevel: 0,
            membership: {
              effectiveLevel: 0,
              key: 'regular',
              appearance: { nameColor: 'default', badge: null },
            },
          },
        ],
        total: 7,
        page: 2,
        limit: 5,
      });
    });

    it('filters by accountId substring when supplied', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findAll({ accountId: 'foo' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId: { contains: 'foo' } },
        }),
      );
    });

    it('filters by status when supplied', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findAll({ status: UserStatus.BANNED });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: UserStatus.BANNED },
        }),
      );
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { status: UserStatus.BANNED },
      });
    });

    it('filters by accountId substring and status together', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findAll({
        accountId: 'foo',
        status: UserStatus.ACTIVE,
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId: { contains: 'foo' },
            status: UserStatus.ACTIVE,
          },
        }),
      );
    });
  });

  describe('findOne', () => {
    it('returns the user (with like status) when found', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        receivedLikeCount: 4,
        vipLevel: 2,
        vipExpiresAt: new Date(Date.now() - 1),
      });
      // Self-view: likedByMeToday is always false and no like lookup is made.
      await expect(service.findOne('user-1')).resolves.toMatchObject({
        id: 'user-1',
        displayIcons: [],
        likeCount: 4,
        likedByMeToday: false,
        vipLevel: 0,
        membership: {
          effectiveLevel: 0,
          key: 'regular',
          appearance: { nameColor: 'default', badge: null },
        },
      });
      const result = await service.findOne('user-1');
      expect(result).not.toHaveProperty('vipExpiresAt');
      expect(prisma.userLike.findUnique).not.toHaveBeenCalled();
    });

    it('filters contact fields according to target privacy settings for other viewers', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'target-1',
        phoneNumber: '13800000000',
        wechat: 'wxid_target',
        qq: '10001',
      });
      privacySettings.canViewProfileField.mockImplementation(
        async (_targetId: string, field: string) => field === 'wechat',
      );

      await expect(
        service.findOne('target-1', 'viewer-1'),
      ).resolves.toMatchObject({
        id: 'target-1',
        phoneNumber: null,
        wechat: 'wxid_target',
        qq: null,
        displayIcons: [],
        likedByMeToday: false,
      });
    });

    it('throws NotFoundException when missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.user.update.mockResolvedValue({ id: 'user-1' });
    });

    it('rejects URL fields that fall outside MINIO_PUBLIC_URL when configured', async () => {
      const guarded = await buildService({
        configGet: () => 'http://10.0.0.195:9000',
      });

      await expect(
        guarded.update('user-1', { avatarUrl: 'http://evil.example.com/x' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('passes the update through when URL fields match the storage prefix', async () => {
      const guarded = await buildService({
        configGet: () => 'http://10.0.0.195:9000',
      });

      await guarded.update('user-1', {
        avatarUrl: 'http://10.0.0.195:9000/circle/avatars/me.png',
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('skips URL safety check when MINIO is not configured', async () => {
      await service.update('user-1', {
        avatarUrl: 'https://example.com/x.png',
      });
      expect(prisma.user.update).toHaveBeenCalled();
      expect(
        realtimeService.invalidateUserProfileSummaryCache,
      ).toHaveBeenCalledWith('user-1');
      // Invalidate the profile-summary hot cache before broadcasting the change.
      expect(
        realtimeService.invalidateUserProfileSummaryCache.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        realtimeService.broadcastUserProfileSummary.mock.invocationCallOrder[0],
      );
    });

    it('normalizes a YYYY-MM-DD birthday into a UTC Date', async () => {
      await service.update('user-1', { birthday: '2018-04-04' });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            birthday: new Date('2018-04-04T00:00:00.000Z'),
          }),
        }),
      );
    });

    it('throws BadRequestException for unparseable birthday strings', async () => {
      await expect(
        service.update('user-1', { birthday: 'not-a-date' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.user.update.mockResolvedValue({ id: 'user-1' });
    });

    it('remove soft-deletes and revokes all sessions', async () => {
      await service.remove('user-1');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: { status: UserStatus.DELETED },
        }),
      );
      expect(refreshTokens.revokeAll).toHaveBeenCalledWith('user-1');
    });

    it('still revokes sessions when optional deletion appearance lookup fails', async () => {
      avatarFrames.resolvePublicAppearances
        .mockResolvedValueOnce(new Map())
        .mockRejectedValueOnce(new Error('appearance unavailable'));

      await expect(service.remove('user-1')).resolves.toEqual(
        expect.objectContaining({ id: 'user-1' }),
      );
      expect(refreshTokens.revokeAll).toHaveBeenCalledWith('user-1');
    });

    it('maps an expired paid membership to the public view in the deletion body', async () => {
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        vipLevel: 3,
        vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      });

      const result = await service.remove('user-1');

      // Expired level 3 → effective 0 and the membership object is present, so
      // the deletion body matches every other public-user response instead of
      // leaking the stored paid tier.
      expect(result.vipLevel).toBe(0);
      expect(result.membership.effectiveLevel).toBe(0);
    });
  });
});
