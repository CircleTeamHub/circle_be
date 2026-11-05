import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotificationService } from './notification.service';
import { UpdateGroupPushPreferenceDto } from './notification.dto';

describe('group offline push preference', () => {
  const user = { findUnique: jest.fn(), update: jest.fn() };
  const service = Object.create(
    NotificationService.prototype,
  ) as NotificationService;
  Object.assign(service, { prisma: { user } });
  beforeEach(() => jest.clearAllMocks());

  it('reads and saves the authenticated account preference', async () => {
    user.findUnique.mockResolvedValue({ groupOfflinePushEnabled: false });
    expect(await service.getGroupPushPreference('me')).toEqual({
      groupOfflinePushEnabled: false,
    });
    user.update.mockResolvedValue({ groupOfflinePushEnabled: true });
    expect(await service.setGroupPushPreference('me', true)).toEqual({
      groupOfflinePushEnabled: true,
    });
    expect(user.update).toHaveBeenCalledWith({
      where: { id: 'me' },
      data: { groupOfflinePushEnabled: true },
      select: { groupOfflinePushEnabled: true },
    });
  });

  it.each(['false', 0, null])(
    'rejects coercing %p into consent',
    async (value) => {
      const dto = plainToInstance(
        UpdateGroupPushPreferenceDto,
        { groupOfflinePushEnabled: value },
        { enableImplicitConversion: true },
      );
      expect(await validate(dto)).not.toHaveLength(0);
    },
  );
});
