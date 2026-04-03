import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';

describe('AuthService', () => {
  let service: AuthService;

  // In-memory user store for tests
  const users: any[] = [];

  const mockPrisma = {
    user: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          users.find(
            (u) => u.username === where.username || u.id === where.id,
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
    },
  };

  const mockRefreshTokenService = {
    create: jest.fn(() => Promise.resolve('refresh-token')),
    rotate: jest.fn(() =>
      Promise.resolve({ token: 'new-refresh-token', userId: 'uuid-1' }),
    ),
    revoke: jest.fn(() => Promise.resolve()),
  };

  const mockJwt = {
    signAsync: jest.fn(() => Promise.resolve('access-token')),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RefreshTokenService, useValue: mockRefreshTokenService },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('register creates user and returns tokens', async () => {
    const result = await service.register({
      username: 'testuser',
      password: 'password1',
      nickname: 'Test User',
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('register throws ConflictException if username taken', async () => {
    await service.register({
      username: 'testuser',
      password: 'password1',
      nickname: 'Test',
    });
    await expect(
      service.register({
        username: 'testuser',
        password: 'password1',
        nickname: 'Test',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('login returns tokens with correct credentials', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      username: 'testuser',
      passwordHash,
      status: 'ACTIVE',
    });

    const result = await service.login({
      username: 'testuser',
      password: 'password1',
    });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('login throws ForbiddenException for unknown user', async () => {
    await expect(
      service.login({ username: 'noone', password: 'password1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('login throws ForbiddenException for wrong password', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      username: 'testuser',
      passwordHash,
      status: 'ACTIVE',
    });

    await expect(
      service.login({ username: 'testuser', password: 'wrongpass' }),
    ).rejects.toThrow(ForbiddenException);
  });
});
