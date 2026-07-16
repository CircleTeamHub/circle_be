import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';
import { OpenimService } from 'src/openim/openim.service';
import { IconService } from 'src/icon/icon.service';
import { EmailVerificationService } from '../email-verification.service';
import { Prisma } from 'src/generated/prisma';

describe('AuthService', () => {
  let service: AuthService;

  // In-memory user store for tests
  const users: any[] = [];

  const mockPrisma = {
    user: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          users.find(
            (u) =>
              (where.accountId !== undefined &&
                u.accountId === where.accountId) ||
              (where.inviteCode !== undefined &&
                u.inviteCode === where.inviteCode) ||
              (where.id !== undefined && u.id === where.id) ||
              (where.email !== undefined && u.email === where.email),
          ) ?? null,
        ),
      ),
      create: jest.fn(async ({ data }) => {
        const { invitedBy, ...fields } = data;
        const user = {
          id: `uuid-${Date.now()}`,
          ...fields,
          ...(invitedBy?.connect?.id
            ? { invitedByUserId: invitedBy.connect.id }
            : {}),
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
    create: jest.fn(() =>
      Promise.resolve({ token: 'refresh-token', sessionId: 'session-1' }),
    ),
    rotate: jest.fn(() =>
      Promise.resolve({
        token: 'new-refresh-token',
        userId: 'uuid-1',
        sessionId: 'session-2',
      }),
    ),
    revoke: jest.fn(() => Promise.resolve()),
    listActiveSessions: jest.fn(() => Promise.resolve([])),
    revokeSession: jest.fn(() => Promise.resolve()),
    revokeOtherSessions: jest.fn(() => Promise.resolve()),
    revokeAll: jest.fn(() => Promise.resolve()),
  };

  const mockJwt = {
    signAsync: jest.fn(() => Promise.resolve('access-token')),
  };

  const mockOpenimService = {
    getUserToken: jest.fn(() => Promise.resolve('')),
    registerUser: jest.fn(() => Promise.resolve()),
  };

  const mockIconService = {
    getDisplayIconsForUser: jest.fn(() => Promise.resolve([])),
  };

  const mockEmailVerification = {
    requestCode: jest.fn(() => Promise.resolve()),
    verifyCode: jest.fn(() => Promise.resolve(true)),
  };

  beforeEach(async () => {
    users.length = 0;
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        users.find(
          (u) =>
            (where.accountId !== undefined &&
              u.accountId === where.accountId) ||
            (where.inviteCode !== undefined &&
              u.inviteCode === where.inviteCode) ||
            (where.id !== undefined && u.id === where.id) ||
            (where.email !== undefined && u.email === where.email),
        ) ?? null,
      ),
    );
    mockPrisma.user.create.mockImplementation(async ({ data }) => {
      const { invitedBy, ...fields } = data;
      const user = {
        id: `uuid-${Date.now()}`,
        ...fields,
        ...(invitedBy?.connect?.id
          ? { invitedByUserId: invitedBy.connect.id }
          : {}),
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
        { provide: IconService, useValue: mockIconService },
        {
          provide: EmailVerificationService,
          useValue: mockEmailVerification,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('register creates user with auto accountId and returns tokens', async () => {
    const result = await service.register({
      email: 'new@example.com',
      code: '123456',
      password: 'password1',
      nickname: 'Test User',
    } as any);
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(users[0].accountId).toMatch(/^[a-z0-9]{6}$/);
    expect(users[0].inviteCode).toBe(users[0].accountId);
    expect(users[0].email).toBe('new@example.com');
  });

  it('register records the active inviter for a normalized invite code', async () => {
    users.push({
      id: 'inviter-1',
      accountId: 'renamed',
      inviteCode: 'abc123',
      email: 'inviter@example.com',
      status: 'ACTIVE',
    });

    await service.register({
      email: 'invitee@example.com',
      code: '123456',
      password: 'password1',
      nickname: 'Invitee',
      inviteCode: '  ABC123  ',
    } as any);

    const invitee = users.find((user) => user.email === 'invitee@example.com');
    expect(invitee.invitedByUserId).toBe('inviter-1');
  });

  it('register rejects an unknown invite code with a stable error code', async () => {
    await expect(
      service.register({
        email: 'invitee@example.com',
        code: '123456',
        password: 'password1',
        nickname: 'Invitee',
        inviteCode: 'missing',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'AUTH_INVITE_CODE_INVALID',
      }),
    });
    expect(users).toHaveLength(0);
  });

  it('register rejects an invite code owned by an inactive user', async () => {
    users.push({
      id: 'inviter-1',
      accountId: 'renamed',
      inviteCode: 'abc123',
      email: 'inviter@example.com',
      status: 'BANNED',
    });

    await expect(
      service.register({
        email: 'invitee@example.com',
        code: '123456',
        password: 'password1',
        nickname: 'Invitee',
        inviteCode: 'abc123',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'AUTH_INVITE_CODE_INVALID',
      }),
    });
    expect(users).toHaveLength(1);
  });

  it('register retries when account/invite-code creation loses a uniqueness race', async () => {
    mockPrisma.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['inviteCode'] },
      }),
    );

    const result = await service.register({
      email: 'race@example.com',
      code: '123456',
      password: 'password1',
      nickname: 'Race',
    } as any);

    expect(result.accessToken).toBe('access-token');
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(2);
    expect(users).toHaveLength(1);
  });

  it('register throws BadRequest when code invalid', async () => {
    mockEmailVerification.verifyCode.mockResolvedValueOnce(false);
    await expect(
      service.register({
        email: 'x@example.com',
        code: '000000',
        password: 'password1',
        nickname: 'X',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('register throws Conflict when email already used', async () => {
    users.push({
      id: 'u0',
      accountId: 'OLD000',
      email: 'dupe@example.com',
      status: 'ACTIVE',
    });
    await expect(
      service.register({
        email: 'dupe@example.com',
        code: '123456',
        password: 'password1',
        nickname: 'Dupe',
      } as any),
    ).rejects.toThrow(ConflictException);
  });

  it('login by email returns tokens with correct password', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });
    const result = await service.login({
      email: 'a@example.com',
      password: 'password1',
    } as any);
    expect(result.accessToken).toBe('access-token');
  });

  it('login still succeeds with empty imToken and logs an error when OpenIM token fetch fails', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });
    mockOpenimService.getUserToken.mockRejectedValueOnce(
      new Error('OpenIM timeout'),
    );
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    const result = await service.login({
      email: 'a@example.com',
      password: 'password1',
    } as any);

    // 登录不被 IM 故障阻断：accessToken 正常、imToken 退化为空串
    expect(result.accessToken).toBe('access-token');
    expect(result.imToken).toBe('');
    // 失败必须「喊出来」——error 级日志且带 userId 上下文
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('uuid-1');
  });

  it('login throws ForbiddenException for unknown email', async () => {
    await expect(
      service.login({
        email: 'noone@example.com',
        password: 'password1',
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('login throws ForbiddenException for wrong password', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });
    await expect(
      service.login({ email: 'a@example.com', password: 'wrongpass' } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('loginWithCode returns tokens when code valid', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockEmailVerification.verifyCode.mockResolvedValueOnce(true);
    const result = await service.loginWithCode({
      email: 'a@example.com',
      code: '123456',
    } as any);
    expect(result.accessToken).toBe('access-token');
  });

  it('loginWithCode throws ForbiddenException when code invalid', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockEmailVerification.verifyCode.mockResolvedValueOnce(false);
    await expect(
      service.loginWithCode({
        email: 'a@example.com',
        code: '000000',
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('login forwards session metadata when issuing tokens', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });

    await service.login(
      { email: 'a@example.com', password: 'password1' } as any,
      {
        deviceName: 'MacBook Pro',
        ip: '127.0.0.1',
        userAgent: 'PostmanRuntime',
      },
    );

    expect(mockRefreshTokenService.create).toHaveBeenCalledWith(
      'uuid-1',
      {
        deviceName: 'MacBook Pro',
        ip: '127.0.0.1',
        userAgent: 'PostmanRuntime',
      },
      'APP',
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'uuid-1', sid: 'session-1', aud: 'APP' }),
    );
  });

  it('login revokes existing sessions first when single-device login is enabled', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: true,
    });

    await service.login({
      email: 'a@example.com',
      password: 'password1',
    } as any);

    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
    expect(mockRefreshTokenService.create).toHaveBeenCalledWith(
      'uuid-1',
      undefined,
      'APP',
    );
  });

  it('adminLogin issues admin-audience tokens for active admin users', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'admin',
      email: 'admin@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'ADMIN',
    });

    const result = await service.adminLogin({
      email: 'admin@example.com',
      password: 'password1',
    } as any);

    expect(result.accessToken).toBe('access-token');
    expect(mockRefreshTokenService.create).toHaveBeenCalledWith(
      'uuid-1',
      undefined,
      'ADMIN',
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'uuid-1',
        role: 'ADMIN',
        sid: 'session-1',
        aud: 'ADMIN',
      }),
    );
  });

  it('adminLogin rejects valid non-admin credentials', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'user',
      email: 'user@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });

    await expect(
      service.adminLogin({
        email: 'user@example.com',
        password: 'password1',
      } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(mockRefreshTokenService.create).not.toHaveBeenCalled();
  });

  it('returns the active sessions for a user', async () => {
    mockRefreshTokenService.listActiveSessions.mockResolvedValueOnce([
      { id: 'session-1' },
      { id: 'session-2' },
    ]);

    const sessions = await service.sessions('uuid-1', 'session-2');

    expect(sessions).toEqual([
      { id: 'session-1', isCurrent: false },
      { id: 'session-2', isCurrent: true },
    ]);
  });

  it('revokes all sessions for a user', async () => {
    await service.logoutAll('uuid-1');

    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
  });

  it('revokes a selected session for the current user', async () => {
    await service.logoutSession('uuid-1', 'session-2');

    expect(mockRefreshTokenService.revokeSession).toHaveBeenCalledWith(
      'uuid-1',
      'session-2',
    );
  });

  it('revokes other sessions while keeping the current session', async () => {
    await service.logoutOtherSessions('uuid-1', 'session-1');

    expect(mockRefreshTokenService.revokeOtherSessions).toHaveBeenCalledWith(
      'uuid-1',
      'session-1',
    );
  });

  it('reads and updates the account-level single-device login setting', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });

    await expect(service.getSingleDeviceLoginStatus('uuid-1')).resolves.toEqual(
      { enabled: false },
    );

    await service.setSingleDeviceLogin('uuid-1', true, 'session-1');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: { singleDeviceLoginEnabled: true },
    });
    expect(mockRefreshTokenService.revokeOtherSessions).toHaveBeenCalledWith(
      'uuid-1',
      'session-1',
    );
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
    expect(mockRefreshTokenService.rotate).toHaveBeenCalledWith(
      'refresh-token',
      undefined,
      'APP',
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'uuid-1', sid: 'session-2', aud: 'APP' }),
    );
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

  it('adminRefresh rotates only admin refresh sessions and returns an admin-audience token', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'admin',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'ADMIN',
      lastOnline: null,
    });

    const result = await service.adminRefresh('refresh-token');

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'new-refresh-token',
    });
    expect(mockRefreshTokenService.rotate).toHaveBeenCalledWith(
      'refresh-token',
      undefined,
      'ADMIN',
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'uuid-1',
        role: 'ADMIN',
        sid: 'session-2',
        aud: 'ADMIN',
      }),
    );
  });

  it('loads city, VIP level, and credit score in the self profile response', async () => {
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
      vipLevel: 3,
      creditScore: 128,
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
        vipLevel: true,
        creditScore: true,
        birthday: true,
        gender: true,
      }),
    });
    // me() now fires a lastOnline update without `select` (the response is
    // synthesized from the already-fetched user) and does not await it.
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: { lastOnline: expect.any(Date) },
    });
    expect(me).toMatchObject({
      city: '杭州',
      gender: 'male',
      vipLevel: 3,
      creditScore: 128,
    });
    expect(me.lastOnline).toBeInstanceOf(Date);
    expect(me.lastOnline.getTime()).toBeGreaterThanOrEqual(beforeMe);
  });

  it('login returns the same error for unknown vs inactive accounts', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'BAN000',
      email: 'banned@example.com',
      passwordHash,
      status: 'BANNED',
      role: 'USER',
    });

    await expect(
      service.login({
        email: 'banned@example.com',
        password: 'password1',
      } as any),
    ).rejects.toThrow(/邮箱或密码错误/);
    await expect(
      service.login({
        email: 'nosuch@example.com',
        password: 'password1',
      } as any),
    ).rejects.toThrow(/邮箱或密码错误/);
  });

  it('refresh blocks inactive users and revokes their sessions', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'BANNED',
      role: 'USER',
      lastOnline: null,
    });

    await expect(service.refresh('refresh-token')).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
  });

  it('changePassword rejects when the old password is wrong', async () => {
    const passwordHash = await argon2.hash('current-password');
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });

    await expect(
      service.changePassword('uuid-1', 'wrong-old', 'new-password'),
    ).rejects.toThrow(UnauthorizedException);
    expect(mockRefreshTokenService.revokeAll).not.toHaveBeenCalled();
  });

  it('changePassword rotates the hash and revokes all sessions on success', async () => {
    const passwordHash = await argon2.hash('current-password');
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });

    await service.changePassword('uuid-1', 'current-password', 'new-password');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'uuid-1' },
        data: expect.objectContaining({
          passwordHash: expect.any(String),
        }),
      }),
    );
    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
  });

  it('changeAccountId rejects an invalid format without touching the DB', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });

    await expect(service.changeAccountId('uuid-1', 'ab')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('changeAccountId rejects an unchanged account id', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });

    await expect(service.changeAccountId('uuid-1', 'alice')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('changeAccountId rejects an id already taken by another user', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    users.push({
      id: 'uuid-2',
      accountId: 'bobby',
      email: 'bob@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });

    await expect(service.changeAccountId('uuid-1', 'bobby')).rejects.toThrow(
      ConflictException,
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('changeAccountId updates the handle and returns the refreshed profile without revoking sessions', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      nickname: 'Alice',
      status: 'ACTIVE',
      role: 'USER',
    });

    const result = await service.changeAccountId('uuid-1', 'alice_2024');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'uuid-1' },
        data: { accountId: 'alice_2024' },
      }),
    );
    expect(result.accountId).toBe('alice_2024');
    // 改 accountId 不应撤销登录态（与改密码不同）
    expect(mockRefreshTokenService.revokeAll).not.toHaveBeenCalled();
  });

  it('changeAccountId normalizes mixed-case input to lowercase before storing', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });

    const result = await service.changeAccountId('uuid-1', 'Alice_2024');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { accountId: 'alice_2024' } }),
    );
    expect(result.accountId).toBe('alice_2024');
  });

  it('changeAccountId rejects a case-variant of an id taken by another user', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    users.push({
      id: 'uuid-2',
      accountId: 'bobby',
      email: 'bob@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });

    await expect(service.changeAccountId('uuid-1', 'BOBBY')).rejects.toThrow(
      ConflictException,
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('changeAccountId maps a concurrent-race P2002 to Conflict (pre-check passes, DB unique constraint loses the race)', async () => {
    // Only the actor exists, so the pre-check findUnique(accountId) returns null
    // and the flow proceeds to update — simulating a competitor that claimed the
    // same id in the window between our check and write.
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockPrisma.user.update.mockImplementationOnce(() => {
      throw new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: 'test',
        },
      );
    });

    await expect(service.changeAccountId('uuid-1', 'bobby')).rejects.toThrow(
      ConflictException,
    );
  });

  it('changeAccountId rethrows a non-P2002 DB error untouched', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockPrisma.user.update.mockImplementationOnce(() => {
      throw new Error('connection reset');
    });

    await expect(service.changeAccountId('uuid-1', 'bobby')).rejects.toThrow(
      'connection reset',
    );
  });

  it('returns login security code status from the account-level hash', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: null,
    });

    await expect(service.getLoginSecurityCodeStatus('uuid-1')).resolves.toEqual(
      { enabled: false },
    );

    users[0].loginSecurityCodeHash = await argon2.hash('1234');

    await expect(service.getLoginSecurityCodeStatus('uuid-1')).resolves.toEqual(
      { enabled: true },
    );
  });

  it('stores login security code as a hash when enabling it', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: null,
    });

    await service.setLoginSecurityCode('uuid-1', '1234');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'uuid-1' },
        data: {
          loginSecurityCodeHash: expect.any(String),
          securityCodeAttempts: 0,
          securityCodeLockedUntil: null,
        },
      }),
    );
    expect(users[0].loginSecurityCodeHash).not.toBe('1234');
    await expect(
      argon2.verify(users[0].loginSecurityCodeHash, '1234'),
    ).resolves.toBe(true);
  });

  it('requires the old login security code before changing an existing code', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: await argon2.hash('1234'),
    });

    await expect(
      service.setLoginSecurityCode('uuid-1', '5678', '0000'),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      service.setLoginSecurityCode('uuid-1', '5678'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('clears login security code after verifying the current code', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: await argon2.hash('1234'),
    });

    await service.disableLoginSecurityCode('uuid-1', '1234');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: {
        loginSecurityCodeHash: null,
        securityCodeAttempts: 0,
        securityCodeLockedUntil: null,
      },
    });
    expect(users[0].loginSecurityCodeHash).toBeNull();
  });

  it('verifies login security code without exposing the hash', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: await argon2.hash('1234'),
    });

    await expect(
      service.verifyLoginSecurityCode('uuid-1', '1234'),
    ).resolves.toEqual({ ok: true });
    await expect(
      service.verifyLoginSecurityCode('uuid-1', '9999'),
    ).resolves.toEqual({ ok: false });
  });

  it('locks security code verification after 5 failed attempts', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: await argon2.hash('1234'),
      securityCodeAttempts: 0,
      securityCodeLockedUntil: null,
    });

    // First 4 wrong guesses just report failure.
    for (let i = 0; i < 4; i++) {
      await expect(
        service.verifyLoginSecurityCode('uuid-1', '9999'),
      ).resolves.toEqual({ ok: false });
    }
    expect(users[0].securityCodeAttempts).toBe(4);

    // 5th wrong guess trips the lock.
    await expect(
      service.verifyLoginSecurityCode('uuid-1', '9999'),
    ).rejects.toThrow(ForbiddenException);
    expect(users[0].securityCodeLockedUntil).toBeInstanceOf(Date);

    // While locked, even the correct code is rejected.
    await expect(
      service.verifyLoginSecurityCode('uuid-1', '1234'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('resets the failure counter after a successful verification', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: await argon2.hash('1234'),
      securityCodeAttempts: 3,
      securityCodeLockedUntil: null,
    });

    await expect(
      service.verifyLoginSecurityCode('uuid-1', '1234'),
    ).resolves.toEqual({ ok: true });
    expect(users[0].securityCodeAttempts).toBe(0);
    expect(users[0].securityCodeLockedUntil).toBeNull();
  });

  it('rejects login security codes outside 4 to 6 digits', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: null,
    });

    await expect(service.setLoginSecurityCode('uuid-1', '123')).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.setLoginSecurityCode('uuid-1', '1234567'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.setLoginSecurityCode('uuid-1', '12ab'),
    ).rejects.toThrow(BadRequestException);
  });

  it('logout delegates to refreshTokenService.revoke', async () => {
    await service.logout('some-refresh-token');
    expect(mockRefreshTokenService.revoke).toHaveBeenCalledWith(
      'some-refresh-token',
    );
  });

  it('me throws NotFoundException when the user no longer exists', async () => {
    await expect(service.me('missing-user-id')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('includes displayIcons in the self profile response', async () => {
    mockIconService.getDisplayIconsForUser.mockResolvedValueOnce([
      {
        id: 'vip-icon',
        type: 'SYSTEM',
        title: 'VIP5',
        imageUrl: null,
        fallbackIconName: 'diamond',
        sortOrder: 0,
      },
    ]);

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
      birthday: null,
      gender: 'male',
      city: '杭州',
      vipLevel: 5,
      creditScore: 100,
      role: 'USER',
      status: 'ACTIVE',
      lastOnline: null,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    const me = await service.me('uuid-1');

    expect(mockIconService.getDisplayIconsForUser).toHaveBeenCalledWith(
      'uuid-1',
    );
    expect(me.displayIcons).toEqual([
      expect.objectContaining({
        title: 'VIP5',
      }),
    ]);
  });
});
