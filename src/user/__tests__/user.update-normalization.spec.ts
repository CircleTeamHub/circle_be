import { UserService } from '../user.service';

describe('UserService.update normalization', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const refreshTokens = {
    revokeAll: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      accountId: 'ACC_TEST1',
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
});
