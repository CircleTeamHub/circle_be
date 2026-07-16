import { BadRequestException } from '@nestjs/common';
import { PrivacySettingsService } from './privacy-settings.service';

describe('PrivacySettingsService', () => {
  const prisma = {
    userPrivacySetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
  };

  let service: PrivacySettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PrivacySettingsService(prisma as any);
  });

  it('returns default account privacy settings without writing when none exist', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue(null);

    await expect(service.getSettings('user-1')).resolves.toMatchObject({
      messageSelfDestructDays: 2,
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
    });

    // A read must never write: lazily creating a row here would let any
    // stranger viewing a profile trigger a write to the target's row.
    expect(prisma.userPrivacySetting.upsert).not.toHaveBeenCalled();
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
