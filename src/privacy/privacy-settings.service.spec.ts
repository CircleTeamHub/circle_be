import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePrivacySettingsDto } from './privacy-settings.dto';
import { PrivacySettingsService } from './privacy-settings.service';

describe('PrivacySettingsService', () => {
  const prisma = {
    userPrivacySetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  let service: PrivacySettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (input: any) => input(prisma));
    service = new PrivacySettingsService(prisma as any);
  });

  it('returns default account privacy settings without writing when none exist', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue(null);

    await expect(service.getSettings('user-1')).resolves.toMatchObject({
      // 自动销毁默认关闭:绝大多数用户库里没有这行,走的就是这份默认值。
      // 默认非 0 等于替所有从没进过隐私设置的人开了「只看得到最近 N 天」。
      messageSelfDestructDays: 0,
      momentsVisibility: 'ALL',
      allowStrangerMessages: true,
      showPhone: false,
      showWechat: true,
      showQQ: true,
      showWhatsup: true,
      addMeByAccount: true,
      addMeByPhone: false,
      addMeByQrCode: true,
      addMeByGroup: true,
      callPermission: 'EVERYONE',
      groupInvitePermission: 'EVERYONE',
      directMessageAutoReplyEnabled: false,
      directMessageAutoReplyText: '',
    });

    // A read must never write: lazily creating a row here would let any
    // stranger viewing a profile trigger a write to the target's row.
    expect(prisma.userPrivacySetting.upsert).not.toHaveBeenCalled();
  });

  it('trims and persists account-synced direct-message auto reply settings', async () => {
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: '稍后回复',
    });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: '  稍后回复  ',
      }),
    ).resolves.toMatchObject({
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: '稍后回复',
    });

    expect(prisma.userPrivacySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          directMessageAutoReplyEnabled: true,
          directMessageAutoReplyText: '稍后回复',
        }),
      }),
    );
  });

  it('validates direct-message auto reply text at both DTO and service boundaries', async () => {
    const tooLong = 'x'.repeat(201);
    const dtoErrors = validateSync(
      plainToInstance(UpdatePrivacySettingsDto, {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: tooLong,
      }),
    );

    expect(
      dtoErrors.some(
        (error) => error.property === 'directMessageAutoReplyText',
      ),
    ).toBe(true);
    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyText: tooLong,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: 'yes' as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects string booleans under the production implicit-conversion pipe', () => {
    for (const raw of ['false', 'true', '0', '1', '']) {
      const dto = plainToInstance(
        UpdatePrivacySettingsDto,
        { directMessageAutoReplyEnabled: raw },
        { enableImplicitConversion: true },
      );
      expect(
        validateSync(dto).some(
          (error) => error.property === 'directMessageAutoReplyEnabled',
        ),
      ).toBe(true);
    }
  });

  it('rejects non-string reply text under the production implicit-conversion pipe', () => {
    for (const raw of [123, false, { text: 'hello' }]) {
      const dto = plainToInstance(
        UpdatePrivacySettingsDto,
        { directMessageAutoReplyText: raw },
        { enableImplicitConversion: true },
      );
      expect(
        validateSync(dto).some(
          (error) => error.property === 'directMessageAutoReplyText',
        ),
      ).toBe(true);
    }
  });

  it('counts Unicode code points consistently with varchar(200)', async () => {
    const twoHundredEmoji = '😀'.repeat(200);
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: twoHundredEmoji,
    });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: twoHundredEmoji,
      }),
    ).resolves.toMatchObject({ directMessageAutoReplyText: twoHundredEmoji });
  });

  it('patches only supplied settings and rejects unsupported enum values', async () => {
    await expect(
      service.updateSettings('user-1', {
        momentsVisibility: 'FRIENDS_ONLY',
        callPermission: 'NOPE' as any,
      }),
    ).rejects.toThrow(BadRequestException);

    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      messageSelfDestructDays: 7,
      momentsVisibility: 'FRIENDS_ONLY',
      allowStrangerMessages: false,
    });

    await service.updateSettings('user-1', {
      messageSelfDestructDays: 7,
      momentsVisibility: 'FRIENDS_ONLY',
      allowStrangerMessages: false,
    });

    expect(prisma.userPrivacySetting.upsert).toHaveBeenLastCalledWith({
      where: { userID: 'user-1' },
      create: expect.objectContaining({
        userID: 'user-1',
        messageSelfDestructDays: 7,
        momentsVisibility: 'FRIENDS_ONLY',
        allowStrangerMessages: false,
      }),
      update: {
        messageSelfDestructDays: 7,
        momentsVisibility: 'FRIENDS_ONLY',
        allowStrangerMessages: false,
      },
    });
  });

  it('serializes privacy changes with authorization reads for the same user', async () => {
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      groupInvitePermission: 'NONE',
    });

    await service.updateSettings('user-1', {
      groupInvitePermission: 'NONE',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      'call-user:user-1',
    );
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.userPrivacySetting.upsert.mock.invocationCallOrder[0],
    );
  });

  it('evaluates viewer permissions from account privacy settings', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'target-1',
      momentsVisibility: 'FRIENDS_ONLY',
      allowStrangerMessages: false,
      showPhone: false,
      showWechat: true,
      showQQ: false,
      showWhatsup: false,
      groupInvitePermission: 'FRIENDS_ONLY',
      callPermission: 'FRIENDS_ONLY',
    });

    await expect(
      service.canReceiveStrangerMessage('target-1', false),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('target-1', 'phoneNumber', false, false),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('target-1', 'wechat', false, false),
    ).resolves.toBe(true);
    await expect(
      service.canViewProfileField('target-1', 'whatsup', false, false),
    ).resolves.toBe(false);
    await expect(
      service.canBeInvitedToGroupOrCircle('target-1', false),
    ).resolves.toBe(false);
    await expect(service.canBeCalled('target-1', true)).resolves.toBe(true);
  });

  describe('getSettingsMany', () => {
    it('returns a map keyed by userID and skips the query when given no ids', async () => {
      await expect(service.getSettingsMany([])).resolves.toEqual(new Map());
      expect(prisma.userPrivacySetting.findMany).not.toHaveBeenCalled();
    });

    it('loads all rows in one query; absent users are simply missing', async () => {
      prisma.userPrivacySetting.findMany.mockResolvedValue([
        { userID: 'a', momentsVisibility: 'PRIVATE' },
      ]);

      const map = await service.getSettingsMany(['a', 'b']);

      expect(prisma.userPrivacySetting.findMany).toHaveBeenCalledTimes(1);
      expect(map.get('a')?.momentsVisibility).toBe('PRIVATE');
      expect(map.has('b')).toBe(false);
    });
  });

  describe('momentsVisibleFor', () => {
    it('always allows the author to see their own moments', () => {
      expect(service.momentsVisibleFor(undefined, true, false)).toBe(true);
    });

    it('defaults to visible when no settings row exists', () => {
      expect(service.momentsVisibleFor(undefined, false, false)).toBe(true);
    });

    it('hides PRIVATE moments from everyone but the author', () => {
      expect(
        service.momentsVisibleFor(
          { momentsVisibility: 'PRIVATE' } as any,
          false,
          true,
        ),
      ).toBe(false);
    });

    it('limits FRIENDS_ONLY moments to friends', () => {
      const settings = { momentsVisibility: 'FRIENDS_ONLY' } as any;
      expect(service.momentsVisibleFor(settings, false, true)).toBe(true);
      expect(service.momentsVisibleFor(settings, false, false)).toBe(false);
    });
  });
});
