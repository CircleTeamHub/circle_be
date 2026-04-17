import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';
import { OpenimService } from 'src/openim/openim.service';

describe('AuthService', () => {
  let service: AuthService;

  // In-memory user store for tests
  const users: any[] = [];

  const mockPrisma = {
    user: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          users.find(
            (u) => u.accountId === where.accountId || u.id === where.id,
          ) ?? null,
        ),
      ),
      create: jest.fn(async ({ data }) => {
        const user = {
          id: `uuid-${Date.now()}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: 'ACTIVE',
        };
        users.push(user);
        return user;
      }),
      update: jest.fn(),
    },
  };

  const mockRefreshTokenService = {
    create: jest.fn(() => Promise.resolve('refresh-token')),
    rotate: jest.fn(() =>
      Promise.resolve({ token: 'new-refresh-token', userId: 'uuid-1' }),
    ),
    revoke: jest.fn(() => Promise.resolve()),
    listActiveSessions: jest.fn(() => Promise.resolve([])),
    revokeAll: jest.fn(() => Promise.resolve()),
  };

  const mockJwt = {
    signAsync: jest.fn(() => Promise.resolve('access-token')),
  };

  const mockOpenimService = {
    getUserToken: jest.fn(() => Promise.resolve('')),
    registerUser: jest.fn(() => Promise.resolve()),
  };

  beforeEach(async () => {
    users.length = 0;
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        users.find((u) => u.username === where.username || u.id === where.id) ??
          null,
      ),
    );
    mockPrisma.user.create.mockImplementation(async ({ data }) => {
      const user = {
        id: `uuid-${Date.now()}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'ACTIVE',
      };
      users.push(user);
      return user;
    });
    mockPrisma.user.update.mockImplementation(
      async ({ where, data, select }) => {
        const user = users.find((u) => u.id === where.id);

        if (!user) {
          throw new Error('User not found');
        }

        Object.assign(user, data, { updatedAt: new Date() });

        if (!select) {
          return user;
        }

        return Object.fromEntries(
          Object.keys(select).map((key) => [key, user[key]]),
        );
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RefreshTokenService, useValue: mockRefreshTokenService },
        { provide: JwtService, useValue: mockJwt },
        { provide: OpenimService, useValue: mockOpenimService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('register creates user and returns tokens', async () => {
    const result = await service.register({
      accountId: 'testuser',
      password: 'password1',
      nickname: 'Test User',
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('register throws ConflictException if username taken', async () => {
    await service.register({
      accountId: 'testuser',
      password: 'password1',
      nickname: 'Test',
    });
    await expect(
      service.register({
        accountId: 'testuser',
        password: 'password1',
        nickname: 'Test',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('login returns tokens with correct credentials', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash,
      status: 'ACTIVE',
    });

    const result = await service.login({
      accountId: 'testuser',
      password: 'password1',
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('login throws ForbiddenException for unknown user', async () => {
    await expect(
      service.login({ accountId: 'noone', password: 'password1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('login throws ForbiddenException for wrong password', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash,
      status: 'ACTIVE',
    });

    await expect(
      service.login({ accountId: 'testuser', password: 'wrongpass' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('login forwards session metadata when issuing tokens', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });

    await service.login(
      { accountId: 'testuser', password: 'password1' },
      {
        deviceName: 'MacBook Pro',
        ip: '127.0.0.1',
        userAgent: 'PostmanRuntime',
      },
    );

    expect(mockRefreshTokenService.create).toHaveBeenCalledWith('uuid-1', {
      deviceName: 'MacBook Pro',
      ip: '127.0.0.1',
      userAgent: 'PostmanRuntime',
    });
  });

  it('returns the active sessions for a user', async () => {
    mockRefreshTokenService.listActiveSessions.mockResolvedValueOnce([
      { id: 'session-1' },
    ]);

    const sessions = await service.sessions('uuid-1');

    expect(sessions).toEqual([{ id: 'session-1' }]);
  });

  it('revokes all sessions for a user', async () => {
    await service.logoutAll('uuid-1');

    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
  });

  it('refresh updates lastOnline before returning new tokens', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      lastOnline: null,
    });

    const beforeRefresh = Date.now();
    const result = await service.refresh('refresh-token');

    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'uuid-1' },
        data: expect.objectContaining({
          lastOnline: expect.any(Date),
        }),
      }),
    );
    expect(users[0].lastOnline.getTime()).toBeGreaterThanOrEqual(beforeRefresh);
  });

  it('loads city in the self profile response', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      nickname: 'Test User',
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
      birthday: new Date('2026-04-01T00:00:00.000Z'),
      gender: 'male',
      city: '杭州',
      role: 'USER',
      status: 'ACTIVE',
      lastOnline: null,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    const beforeMe = Date.now();
    const me = await service.me('uuid-1');

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      select: expect.objectContaining({
        city: true,
        birthday: true,
        gender: true,
      }),
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'uuid-1' },
        data: expect.objectContaining({
          lastOnline: expect.any(Date),
        }),
        select: expect.objectContaining({
          city: true,
          birthday: true,
          gender: true,
        }),
      }),
    );
    expect(me).toMatchObject({
      city: '杭州',
      gender: 'male',
    });
    expect(me.lastOnline).toBeInstanceOf(Date);
    expect(me.lastOnline.getTime()).toBeGreaterThanOrEqual(beforeMe);
  });
});
