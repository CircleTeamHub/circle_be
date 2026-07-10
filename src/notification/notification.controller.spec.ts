import { NotificationController } from './notification.controller';

describe('NotificationController', () => {
  it('registers a push token for the current user', async () => {
    const notificationService = {
      registerPushToken: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new NotificationController(notificationService as any);
    const dto = {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
      provider: 'expo',
      projectId: 'project-1',
      appVersion: '1.0.0',
    } as const;

    await controller.registerPushToken(dto, {
      user: { userId: 'user-1' },
    } as any);

    expect(notificationService.registerPushToken).toHaveBeenCalledWith(
      'user-1',
      dto,
    );
  });

  it('deletes a push token for the current user', async () => {
    const notificationService = {
      deletePushToken: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new NotificationController(notificationService as any);

    await controller.deletePushToken({ token: 'ExponentPushToken[abc]' }, {
      user: { userId: 'user-1' },
    } as any);

    expect(notificationService.deletePushToken).toHaveBeenCalledWith(
      'user-1',
      'ExponentPushToken[abc]',
    );
  });

  it('lists profile-domain system notifications for the current user', async () => {
    const notificationService = {
      getProfileNotifications: jest.fn().mockResolvedValue([]),
    };
    const controller = new NotificationController(notificationService as any);

    await controller.profileList({ page: 3 }, {
      user: { userId: 'user-1' },
    } as any);

    expect(notificationService.getProfileNotifications).toHaveBeenCalledWith(
      'user-1',
      3,
    );
  });
});
