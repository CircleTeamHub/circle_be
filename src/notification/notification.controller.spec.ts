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

  it('forwards the bell domain to the notification list', async () => {
    const notificationService = {
      getNotifications: jest.fn().mockResolvedValue([]),
    };
    const controller = new NotificationController(notificationService as any);

    await controller.list({ page: 2, domain: 'circle' }, {
      user: { userId: 'user-1' },
    } as any);

    expect(notificationService.getNotifications).toHaveBeenCalledWith(
      'user-1',
      2,
      'circle',
    );
  });

  it('forwards the bell domain to mark-all-read so one bell cannot clear the other', async () => {
    const notificationService = {
      markAllNotificationsRead: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const controller = new NotificationController(notificationService as any);

    await controller.readAll({ domain: 'moments' }, {
      user: { userId: 'user-1' },
    } as any);

    expect(notificationService.markAllNotificationsRead).toHaveBeenCalledWith(
      'user-1',
      'moments',
    );
  });

  // 这两条端点读写的是 per-user 的推送开关：路由上没有 userId，唯一的收件人
  // 身份来自 JWT。controller 若从 body/query 取 id，一个人就能改别人的推送设置。
  it('reads the circle push preference for the authenticated user only', async () => {
    const notificationService = {
      getCirclePushPreference: jest
        .fn()
        .mockResolvedValue({ circleOfflinePushEnabled: false }),
    };
    const controller = new NotificationController(notificationService as any);

    await expect(
      controller.getCirclePushPreference({
        user: { userId: 'user-1' },
      } as any),
    ).resolves.toEqual({ circleOfflinePushEnabled: false });

    expect(notificationService.getCirclePushPreference).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('writes the circle push preference for the authenticated user only', async () => {
    const notificationService = {
      setCirclePushPreference: jest
        .fn()
        .mockResolvedValue({ circleOfflinePushEnabled: false }),
    };
    const controller = new NotificationController(notificationService as any);

    await expect(
      controller.setCirclePushPreference(
        { user: { userId: 'user-1' } } as any,
        { circleOfflinePushEnabled: false },
      ),
    ).resolves.toEqual({ circleOfflinePushEnabled: false });

    expect(notificationService.setCirclePushPreference).toHaveBeenCalledWith(
      'user-1',
      false,
    );
  });

  // 回显必须是服务端写完之后的真值：客户端拿它对账本地镜像，回显请求体
  // 等于「无论写没写成都说写成了」。
  it('echoes the stored value rather than the request body', async () => {
    const notificationService = {
      setCirclePushPreference: jest
        .fn()
        .mockResolvedValue({ circleOfflinePushEnabled: true }),
    };
    const controller = new NotificationController(notificationService as any);

    await expect(
      controller.setCirclePushPreference(
        { user: { userId: 'user-1' } } as any,
        { circleOfflinePushEnabled: false },
      ),
    ).resolves.toEqual({ circleOfflinePushEnabled: true });
  });

  it('checks notification ownership using the authenticated user and route id', async () => {
    const notificationService = {
      getNotificationOpenOwnership: jest
        .fn()
        .mockResolvedValue({ owned: true }),
    };
    const controller = new NotificationController(notificationService as any);

    await expect(
      controller.openOwnership('00000000-0000-4000-8000-000000000001', {
        user: { userId: 'user-1' },
      } as any),
    ).resolves.toEqual({ owned: true });

    expect(
      notificationService.getNotificationOpenOwnership,
    ).toHaveBeenCalledWith('user-1', '00000000-0000-4000-8000-000000000001');
  });
});
