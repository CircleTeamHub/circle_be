import { UserService } from '../user.service';

describe('UserService.update normalization', () => {
  const iconService = {
    getDisplayIconsForUser: jest.fn(() => Promise.resolve([])),
  };
  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(() => Promise.resolve()),
    invalidateUserProfileSummaryCache: jest.fn(() => Promise.resolve()),
  };

  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    userProfileSyncOutbox: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async (operation: any) => operation(prisma)),
  };
  const refreshTokens = {
    revokeAll: jest.fn().mockResolvedValue(undefined),
  };
  // update() does not exercise profile-privacy filtering, but UserService now
  // requires the dependency (fail-closed). Provide a permissive stub.
  const privacySettings = {
    canViewProfileField: jest.fn().mockResolvedValue(true),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userProfileSyncOutbox.upsert.mockReset();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      accountId: 'TEST01',
      nickname: 'Tester',
      avatarUrl: null,
      avatarFrame: null,
      cover: null,
      email: null,
      phoneNumber: null,
      wechat: null,
      qq: null,
      whatsup: null,
      persona: null,
      helloWords: null,
      birthday: null,
      gender: 'unset',
      city: null,
      role: 'USER',
      status: 'ACTIVE',
      lastOnline: null,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    prisma.user.update.mockResolvedValue({ id: 'user-1' });
  });

  it('converts birthday updates from yyyy-mm-dd to Date', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', { birthday: '2018-04-04' });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          birthday: new Date('2018-04-04T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('passes through non-date profile fields unchanged', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', {
      nickname: 'jimmy',
      gender: 'male' as any,
      persona: 'hello world',
      wechat: 'jimmy123',
      phoneNumber: '13800138000',
      qq: '1234567',
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nickname: 'jimmy',
          gender: 'male',
          persona: 'hello world',
          wechat: 'jimmy123',
          phoneNumber: '13800138000',
          qq: '1234567',
        },
      }),
    );
  });

  it('persists city updates unchanged', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', {
      city: '杭州',
      gender: 'female' as any,
    } as any);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          city: '杭州',
          gender: 'female',
        }),
      }),
    );
  });

  it('persists region updates through to prisma', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', {
      region: '上海',
      city: '杭州',
    } as any);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          region: '上海',
          city: '杭州',
        }),
      }),
    );
  });

  it('trims surrounding whitespace on text fields', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', {
      region: '  上海  ',
      nickname: '  jimmy  ',
    } as any);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          region: '上海',
          nickname: 'jimmy',
        }),
      }),
    );
    expect(prisma.userProfileSyncOutbox.upsert).toHaveBeenCalledWith({
      where: { userID: 'user-1' },
      create: { userID: 'user-1', generation: 1 },
      update: expect.objectContaining({
        status: 'PENDING',
        generation: { increment: 1 },
      }),
    });
  });

  it('converts blank/whitespace-only nullable fields to null', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', {
      city: '   ',
      region: '',
      persona: '  ',
    } as any);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          city: null,
          region: null,
          persona: null,
        }),
      }),
    );
  });

  it('keeps required nickname as empty string (never nulled) when blank', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', { nickname: '   ' } as any);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nickname: '' },
      }),
    );
  });

  it('queues a nickname/avatar change for durable OpenIM sync', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', {
      nickname: '新昵称',
      avatarUrl: 'https://cdn/a.jpg',
    } as any);

    expect(prisma.userProfileSyncOutbox.upsert).toHaveBeenCalledWith({
      where: { userID: 'user-1' },
      create: { userID: 'user-1', generation: 1 },
      update: expect.objectContaining({
        status: 'PENDING',
        generation: { increment: 1 },
      }),
    });
  });

  it('fails the profile transaction when sync enqueue fails', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );
    prisma.userProfileSyncOutbox.upsert.mockRejectedValue(
      new Error('profile outbox unavailable'),
    );

    await expect(
      service.update('user-1', { nickname: '新昵称' }),
    ).rejects.toThrow('profile outbox unavailable');
  });

  it('preserves an active worker lease when a newer profile supersedes it', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', { nickname: 'newer' });

    const update = prisma.userProfileSyncOutbox.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('leaseToken');
    expect(update).not.toHaveProperty('lockedAt');
  });

  it('does NOT enqueue a sync when neither nickname nor avatar changes', async () => {
    const config = { get: jest.fn().mockReturnValue(null) };
    const service = new UserService(
      prisma as any,
      config as any,
      refreshTokens as any,
      iconService as any,
      realtimeService as any,
      privacySettings as any,
    );

    await service.update('user-1', { persona: 'just a bio' } as any);

    expect(prisma.userProfileSyncOutbox.upsert).not.toHaveBeenCalled();
  });
});
