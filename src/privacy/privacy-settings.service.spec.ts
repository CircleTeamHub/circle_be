import { BadRequestException } from '@nestjs/common';
import { PrivacySettingsService } from './privacy-settings.service';

describe('PrivacySettingsService', () => {
  const prisma = {
    userPrivacySetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
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
      service.canBeInvitedToGroupOrCircle('target-1', false),
    ).resolves.toBe(false);
    await expect(service.canBeCalled('target-1', true)).resolves.toBe(true);
  });
});
