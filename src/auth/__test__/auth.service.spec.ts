import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { DeviceTrustService } from '../device-trust.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';
import { IconService } from 'src/icon/icon.service';
import { EmailVerificationService } from '../email-verification.service';
import { Prisma } from 'src/generated/prisma';
import { FancyNumberService } from 'src/fancy-number/fancy-number.service';
import { AvatarFrameService } from 'src/avatar-frame/avatar-frame.service';
import { AuthErrorCode } from 'src/common/app-error-codes';

describe('AuthService', () => {
  let service: AuthService;

  // In-memory user store for tests
  const users: any[] = [];

  const mockPrisma = {
    adminAccess: { findUnique: jest.fn() },
    adminAuditLog: { create: jest.fn() },
    campaignInvite: { findUnique: jest.fn() },
    campaignInviteUse: { create: jest.fn() },
    $queryRaw: jest.fn(),
    accountIdentifier: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
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
      // 账号/邀请码分配改成批量候选查询：按内存用户表回答 IN 查询。
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.accountId
            ? users
                .filter((u) => where.accountId.in.includes(u.accountId))
                .map((u) => ({ accountId: u.accountId }))
            : users
                .filter((u) => where.inviteCode.in.includes(u.inviteCode))
                .map((u) => ({ inviteCode: u.inviteCode })),
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
    referral: { create: jest.fn() },
    fancyNumberLease: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    $transaction: jest.fn(async (operation: any) => operation(mockPrisma)),
  };

  const mockDeviceTrust = {
    trust: jest.fn().mockResolvedValue(undefined),
    listDetachedDevices: jest.fn().mockResolvedValue([]),
    deviceKeyForRecord: jest.fn().mockResolvedValue(null),
    evaluateLogin: jest.fn(() => Promise.resolve({ kind: 'trusted' })),
    trustOnRefresh: jest.fn(() => Promise.resolve()),
    revokeDevice: jest.fn(() => Promise.resolve()),
    revokeOtherDevices: jest.fn(() => Promise.resolve()),
    registerSecurityCodeFailure: jest.fn(() => Promise.resolve()),
    invalidateChallenges: jest.fn(() => Promise.resolve()),
    assertSecurityCodeFallbackBudget: jest.fn(() => Promise.resolve()),
    verifySecurityCodeFallback: jest.fn(async (_id, _deviceKey, verify) =>
      verify(),
    ),
    loadForSecurityCode: jest.fn(),
    consumeAfterSecurityCode: jest.fn(() => Promise.resolve()),
    consumeWithCode: jest.fn(),
    completeVerifiedLogin: jest.fn(() => Promise.resolve()),
    isTrusted: jest.fn(() => Promise.resolve(true)),
    cancelRecoveriesForActiveDevice: jest.fn(() => Promise.resolve()),
    requestRecovery: jest.fn(),
    logRecoveryCompleted: jest.fn(),
    releaseRecoveryClaim: jest.fn(() => Promise.resolve()),
  };
  const mockRefreshTokenService = {
    create: jest.fn(() =>
      Promise.resolve({ token: 'refresh-token', sessionId: 'session-1' }),
    ),
    createAppSession: jest.fn(() =>
      Promise.resolve({ token: 'refresh-token', sessionId: 'session-1' }),
    ),
    createSessionForCurrentSingleDeviceSetting: jest.fn(() =>
      Promise.resolve({ token: 'refresh-token', sessionId: 'session-1' }),
    ),
    ownerForToken: jest.fn().mockResolvedValue('uuid-1'),
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
    revokeSessionFamily: jest.fn(() => Promise.resolve()),
    revokeOtherSessions: jest.fn(() => Promise.resolve()),
    revokeDeviceSessions: jest.fn(() => Promise.resolve()),
    findSessionDeviceKey: jest.fn((_userId: string, sessionId: string) =>
      Promise.resolve(`device-key-of-${sessionId}`),
    ),
    revokeAll: jest.fn(() => Promise.resolve()),
    replaceForSingleDevice: jest.fn(() =>
      Promise.resolve({ token: 'refresh-token', sessionId: 'session-1' }),
    ),
    setSingleDeviceLogin: jest.fn(() => Promise.resolve()),
    assertSessionActive: jest.fn(() => Promise.resolve()),
    recordAccessTokenIssued: jest.fn(() => Promise.resolve()),
  };

  const mockJwt = {
    signAsync: jest.fn(() => Promise.resolve('access-token')),
  };

  const mockIconService = {
    getDisplayIconsForUser: jest.fn(() => Promise.resolve([])),
  };

  const mockEmailVerification = {
    requestCode: jest.fn(() => Promise.resolve()),
    verifyCode: jest.fn(() => Promise.resolve(true)),
  };
  const mockFancyNumberService = {
    ensureAccountIdChangeAllowed: jest.fn(() => Promise.resolve()),
  };
  const mockAvatarFrameService = {
    resolvePublicAppearances: jest.fn(() => Promise.resolve(new Map())),
  };

  beforeEach(async () => {
    users.length = 0;
    jest.clearAllMocks();
    mockRefreshTokenService.findSessionDeviceKey.mockImplementation(
      async (_userId: string, sessionId: string) =>
        `device-key-of-${sessionId}`,
    );
    mockDeviceTrust.loadForSecurityCode.mockResolvedValue({
      userId: 'uuid-1',
      deviceKey: 'new-device',
    } as never);
    mockPrisma.adminAccess.findUnique.mockResolvedValue({
      role: 'SUPER_ADMIN',
    });
    mockPrisma.adminAuditLog.create.mockResolvedValue({});
    mockPrisma.campaignInvite.findUnique.mockResolvedValue(null);
    mockPrisma.campaignInviteUse.create.mockResolvedValue({});
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'campaign-1' }]);
    mockPrisma.accountIdentifier.findUnique.mockResolvedValue(null);
    mockPrisma.fancyNumberLease.findFirst.mockResolvedValue(null);
    mockFancyNumberService.ensureAccountIdChangeAllowed.mockResolvedValue();
    mockAvatarFrameService.resolvePublicAppearances.mockResolvedValue(
      new Map(),
    );
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
    mockPrisma.user.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.accountId
          ? users
              .filter((u) => where.accountId.in.includes(u.accountId))
              .map((u) => ({ accountId: u.accountId }))
          : users
              .filter((u) => where.inviteCode.in.includes(u.inviteCode))
              .map((u) => ({ inviteCode: u.inviteCode })),
      ),
    );
    mockPrisma.accountIdentifier.findMany.mockResolvedValue([]);
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
        { provide: IconService, useValue: mockIconService },
        {
          provide: EmailVerificationService,
          useValue: mockEmailVerification,
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: FancyNumberService, useValue: mockFancyNumberService },
        { provide: AvatarFrameService, useValue: mockAvatarFrameService },
        { provide: DeviceTrustService, useValue: mockDeviceTrust },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('does not create a session when initial trusted-device enrollment fails', async () => {
    mockDeviceTrust.trust.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      service.register(
        {
          email: 'new@example.com',
          confirmPassword: 'password1',
          password: 'password1',
          nickname: 'Test',
        } as any,
        { deviceKey: 'new-device' },
      ),
    ).rejects.toThrow('database unavailable');
    expect(mockRefreshTokenService.createAppSession).not.toHaveBeenCalled();
    expect(
      mockRefreshTokenService.createSessionForCurrentSingleDeviceSetting,
    ).not.toHaveBeenCalled();
  });

  it('removing another device invalidates challenges it could have approved', async () => {
    mockRefreshTokenService.findSessionDeviceKey
      .mockResolvedValueOnce('attacker')
      .mockResolvedValueOnce('owner');
    await service.logoutSession('uuid-1', 'attacker-session', 'owner-session');
    expect(mockDeviceTrust.invalidateChallenges).toHaveBeenCalledWith('uuid-1');
  });

  it('keeps detached trusted devices visible and removable by their opaque record IDs', async () => {
    mockRefreshTokenService.listActiveSessions.mockResolvedValueOnce([]);
    mockDeviceTrust.listDetachedDevices.mockResolvedValueOnce([
      { id: 'trusted-record', deviceName: 'Old phone' },
    ] as never);
    expect(await service.sessions('uuid-1')).toEqual([
      { id: 'trusted-record', deviceName: 'Old phone', isCurrent: false },
    ]);
    mockRefreshTokenService.findSessionDeviceKey.mockResolvedValueOnce(null);
    mockDeviceTrust.deviceKeyForRecord.mockResolvedValueOnce('old-device');
    await service.logoutSession('uuid-1', 'trusted-record');
    expect(mockDeviceTrust.deviceKeyForRecord).toHaveBeenCalledWith(
      'uuid-1',
      'trusted-record',
    );
    expect(mockDeviceTrust.revokeDevice).toHaveBeenCalledWith(
      'uuid-1',
      'old-device',
    );
  });

  it('holds recovery behind refresh rotation and final device trust enrollment', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });
    let rotating!: () => void;
    const started = new Promise<void>((resolve) => {
      rotating = resolve;
    });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRefreshTokenService.rotate.mockImplementationOnce(async () => {
      rotating();
      await pause;
      return {
        token: 'new-refresh-token',
        userId: 'uuid-1',
        sessionId: 'session-2',
        deviceKey: 'old-device',
      } as any;
    });
    const original = mockPrisma.$transaction.getMockImplementation();
    let queue: Promise<unknown> = Promise.resolve();
    mockPrisma.$transaction.mockImplementation((operation: any) => {
      const task = queue.then(() => operation(mockPrisma));
      queue = task.catch(() => {});
      return task;
    });
    try {
      const refresh = service.refresh('refresh-token');
      await started;
      const recovery = service.logoutAll('uuid-1');
      await Promise.resolve();
      expect(mockRefreshTokenService.revokeAll).not.toHaveBeenCalled();
      release();
      await Promise.all([refresh, recovery]);
      expect(
        mockDeviceTrust.trustOnRefresh.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockRefreshTokenService.revokeAll.mock.invocationCallOrder[0],
      );
    } finally {
      mockPrisma.$transaction.mockImplementation(original!);
    }
  });

  it('register creates user with auto accountId and returns tokens', async () => {
    const result = await service.register({
      email: 'new@example.com',
      confirmPassword: 'password1',
      password: 'password1',
      nickname: 'Test User',
    } as any);
    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(result.refreshToken).toBe('refresh-token');
    expect(users[0].accountId).toMatch(/^\d{6}$/);
    expect(users[0].inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(users[0].email).toBe('new@example.com');
  });

  it('register rejects mismatched confirmation passwords', async () => {
    await expect(
      service.register({
        email: 'mismatch@example.com',
        password: 'password1',
        confirmPassword: 'password2',
        nickname: 'Mismatch',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'AUTH_PASSWORD_MISMATCH',
      }),
    });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalledWith({
      where: { email: 'mismatch@example.com' },
    });
  });

  it('register records the active inviter for a normalized invite code', async () => {
    users.push({
      id: 'inviter-1',
      accountId: 'renamed',
      inviteCode: 'ABC123',
      email: 'inviter@example.com',
      status: 'ACTIVE',
    });

    await service.register({
      email: 'invitee@example.com',
      confirmPassword: 'password1',
      password: 'password1',
      nickname: 'Invitee',
      inviteCode: '  abc123  ',
    } as any);

    const invitee = users.find((user) => user.email === 'invitee@example.com');
    expect(invitee.invitedByUserId).toBe('inviter-1');
    expect(mockPrisma.referral.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inviterID: 'inviter-1',
        inviteeID: invitee.id,
        status: 'PENDING',
        inviterReward: 20,
        inviteeReward: 5,
      }),
    });
  });

  it('register rejects an unknown invite code with a stable error code', async () => {
    await expect(
      service.register({
        email: 'invitee@example.com',
        confirmPassword: 'password1',
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
      inviteCode: 'ABC123',
      email: 'inviter@example.com',
      status: 'BANNED',
    });

    await expect(
      service.register({
        email: 'invitee@example.com',
        confirmPassword: 'password1',
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

  it('register attributes a usable campaign code to its owner and records its use', async () => {
    mockPrisma.campaignInvite.findUnique.mockResolvedValue({
      id: 'campaign-1',
      enabled: true,
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 10,
      usedCount: 0,
      owner: { id: 'owner-1', status: 'ACTIVE', role: 'USER' },
    });

    const result = await service.register({
      email: 'campaign@example.com',
      password: 'password1',
      confirmPassword: 'password1',
      nickname: 'Campaign invitee',
      inviteCode: ' campaign-code ',
    } as any);

    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(mockPrisma.campaignInvite.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: 'CAMPAIGN-CODE' } }),
    );
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ invitedByUserId: 'owner-1' }),
    });
    expect(mockPrisma.campaignInviteUse.create).toHaveBeenCalledWith({
      data: { campaignID: 'campaign-1', userID: users[0].id },
    });
    expect(mockPrisma.referral.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inviterID: 'owner-1',
        inviteeID: users[0].id,
      }),
    });
  });

  it.each([
    ['expired', { expiresAt: new Date(0) }],
    ['exhausted', { usedCount: 10 }],
    ['disabled', { enabled: false }],
    [
      'inactive owner',
      { owner: { id: 'owner-1', status: 'BANNED', role: 'USER' } },
    ],
    [
      'admin owner',
      { owner: { id: 'owner-1', status: 'ACTIVE', role: 'ADMIN' } },
    ],
  ])('register rejects a campaign with %s', async (_name, overrides) => {
    mockPrisma.campaignInvite.findUnique.mockResolvedValue({
      id: 'campaign-1',
      enabled: true,
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 10,
      usedCount: 0,
      owner: { id: 'owner-1', status: 'ACTIVE', role: 'USER' },
      ...overrides,
    });

    await expect(
      service.register({
        email: 'campaign@example.com',
        password: 'password1',
        confirmPassword: 'password1',
        nickname: 'Campaign invitee',
        inviteCode: 'CAMPAIGN-CODE',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: AuthErrorCode.InviteCodeInvalid,
      }),
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.campaignInviteUse.create).not.toHaveBeenCalled();
  });

  it('register rejects a campaign whose last use is claimed concurrently', async () => {
    mockPrisma.campaignInvite.findUnique.mockResolvedValue({
      id: 'campaign-1',
      enabled: true,
      expiresAt: new Date(Date.now() + 60_000),
      maxUses: 1,
      usedCount: 0,
      owner: { id: 'owner-1', status: 'ACTIVE', role: 'USER' },
    });
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.register({
        email: 'campaign@example.com',
        password: 'password1',
        confirmPassword: 'password1',
        nickname: 'Campaign invitee',
        inviteCode: 'CAMPAIGN-CODE',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: AuthErrorCode.InviteCodeInvalid,
      }),
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.campaignInviteUse.create).not.toHaveBeenCalled();
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
      confirmPassword: 'password1',
      password: 'password1',
      nickname: 'Race',
    } as any);

    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(2);
    expect(users).toHaveLength(1);
  });

  // review 修复：触发器抢占报的是 plpgsql P0001（'account identifier collision'），
  // 不是 Prisma 的 P2002。不分类它，输掉并发的那次注册会以 500 收场而不是换码重试。
  it('register retries when the identifier trigger reports a claim collision', async () => {
    let rejectedAccountId = '';
    mockPrisma.user.create.mockImplementationOnce(({ data }: any) => {
      rejectedAccountId = data.accountId;
      return Promise.reject(
        new Error(
          'Raw query failed. Code: `P0001`. Message: `ERROR: account identifier ' +
            `collision: ${data.accountId}\``,
        ),
      );
    });

    const result = await service.register({
      email: 'trigger-race@example.com',
      confirmPassword: 'password1',
      password: 'password1',
      nickname: 'TriggerRace',
    } as any);

    expect(rejectedAccountId).toMatch(/^\d{6}$/);
    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(2);
    expect(users).toHaveLength(1);
    expect(users[0].accountId).not.toBe(rejectedAccountId);
  });

  it('register retries when the trigger rejects the generated invite code', async () => {
    let rejectedInviteCode = '';
    mockPrisma.user.create.mockImplementationOnce(({ data }: any) => {
      rejectedInviteCode = data.inviteCode;
      return Promise.reject(
        new Error(`account identifier collision: ${data.inviteCode}`),
      );
    });

    const result = await service.register({
      email: 'trigger-invite@example.com',
      confirmPassword: 'password1',
      password: 'password1',
      nickname: 'TriggerInvite',
    } as any);

    expect(rejectedInviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(2);
  });

  it('register surfaces unrelated database errors instead of retrying', async () => {
    mockPrisma.user.create.mockImplementation(() =>
      Promise.reject(new Error('connection reset')),
    );

    await expect(
      service.register({
        email: 'db-down@example.com',
        confirmPassword: 'password1',
        password: 'password1',
        nickname: 'DbDown',
      } as any),
    ).rejects.toThrow('connection reset');
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('register returns service unavailable after exhausting uniqueness-race retries', async () => {
    mockPrisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['inviteCode'] },
      }),
    );

    await expect(
      service.register({
        email: 'exhausted@example.com',
        confirmPassword: 'password1',
        password: 'password1',
        nickname: 'Exhausted',
      } as any),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(10);
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
        confirmPassword: 'password1',
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
    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
  });

  it('login by user ID returns tokens with correct password', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-account-id',
      accountId: 'user_123',
      email: 'id-login@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });
    const result = await service.login({
      identifier: ' user_123 ',
      password: 'password1',
    } as any);
    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
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

    expect(mockRefreshTokenService.createAppSession).toHaveBeenCalledWith(
      'uuid-1',
      {
        deviceName: 'MacBook Pro',
        ip: '127.0.0.1',
        userAgent: 'PostmanRuntime',
      },
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'uuid-1',
        sid: 'session-1',
        aud: 'APP',
        issuedAtMs: expect.any(Number),
      }),
    );
    const [[signedPayload]] = mockJwt.signAsync.mock.calls as unknown as [
      [{ issuedAtMs: number }],
    ];
    expect(
      mockRefreshTokenService.recordAccessTokenIssued,
    ).toHaveBeenCalledWith(
      'uuid-1',
      'session-1',
      new Date(signedPayload.issuedAtMs + 60 * 60 * 1000),
    );
  });

  it('does not burn a rotated refresh token when expiry metadata persistence fails', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockRefreshTokenService.recordAccessTokenIssued.mockRejectedValueOnce(
      new Error('transient database failure'),
    );

    await expect(service.refresh('refresh-token')).resolves.toEqual(
      expect.objectContaining({
        accessToken: 'access-token',
        refreshToken: 'new-refresh-token',
      }),
    );
    expect(mockRefreshTokenService.assertSessionActive).toHaveBeenCalledWith(
      'uuid-1',
      'session-2',
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

    expect(mockRefreshTokenService.createAppSession).toHaveBeenCalledWith(
      'uuid-1',
      undefined,
    );
    expect(mockRefreshTokenService.create).not.toHaveBeenCalled();
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

    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(
      mockRefreshTokenService.createSessionForCurrentSingleDeviceSetting,
    ).toHaveBeenCalledWith('uuid-1', undefined, 'ADMIN');
    expect(mockRefreshTokenService.create).not.toHaveBeenCalled();
    expect(mockRefreshTokenService.create).not.toHaveBeenCalledWith(
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
      // #91：ADMIN audience 使用独立的更短 access TTL（默认 15m）
      // 秒数：min(admin 15m, 全局 1h) —— TTL 钳制后签名参数为秒
      expect.objectContaining({ expiresIn: 900 }),
    );
    expect(mockPrisma.adminAccess.findUnique).toHaveBeenCalledWith({
      where: { userID: 'uuid-1' },
      select: { role: true },
    });
    expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.login.success',
        actorID: 'uuid-1',
      }),
    });
  });

  it('rejects an old-password admin login if a super administrator resets it while issuing a session', async () => {
    const user = {
      id: 'uuid-1',
      accountId: 'admin',
      email: 'admin@example.com',
      passwordHash: await argon2.hash('InitialPass1234'),
      status: 'ACTIVE',
      role: 'ADMIN',
    };
    users.push(user);
    mockRefreshTokenService.createSessionForCurrentSingleDeviceSetting.mockImplementationOnce(
      async () => {
        user.passwordHash = await argon2.hash('NewPassword5678');
        return { token: 'refresh-token', sessionId: 'session-1' };
      },
    );
    await expect(
      service.adminLogin({ email: user.email, password: 'InitialPass1234' }),
    ).rejects.toThrow('密码或账号状态已变化');
    expect(mockJwt.signAsync).not.toHaveBeenCalled();
    expect(mockRefreshTokenService.revoke).toHaveBeenCalledWith(
      'refresh-token',
    );
  });

  it('does not send self-service password recovery codes for administrator accounts', async () => {
    users.push({
      id: 'uuid-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    await service.requestPasswordReset('admin@example.com');
    expect(mockEmailVerification.requestCode).not.toHaveBeenCalled();
  });
  it('rejects email-code password reset for administrator accounts even with a valid code', async () => {
    users.push({
      id: 'uuid-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      status: 'ACTIVE',
      passwordHash: 'existing-hash',
    });
    await expect(
      service.resetPassword('admin@example.com', '123456', 'NewPassword5678'),
    ).rejects.toThrow(ForbiddenException);
    expect(users[0].passwordHash).toBe('existing-hash');
    expect(mockRefreshTokenService.revokeAll).not.toHaveBeenCalled();
  });
  it('denies self-service password changes for administrator accounts', async () => {
    users.push({
      id: 'uuid-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      status: 'ACTIVE',
      passwordHash: await argon2.hash('InitialPass1234'),
    });
    await expect(
      service.changePassword('uuid-1', 'InitialPass1234', 'NewPassword5678'),
    ).rejects.toThrow('管理员密码由超级管理员设置');
  });

  it('logs in an administrator by account name without an email and normalizes casing', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'support_01',
      email: null,
      role: 'ADMIN',
      status: 'ACTIVE',
      passwordHash: await argon2.hash('AccountPass1234'),
    });
    await expect(
      service.adminLogin({
        identifier: '  SUPPORT_01  ',
        password: 'AccountPass1234',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ accessToken: 'access-token' }),
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'support_01', aud: 'ADMIN' }),
      expect.anything(),
    );
  });
  it('does not grant admin access to ordinary app users logging in by account name', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'support_01',
      email: null,
      role: 'USER',
      status: 'ACTIVE',
      passwordHash: await argon2.hash('AccountPass1234'),
    });
    await expect(
      service.adminLogin({
        identifier: 'support_01',
        password: 'AccountPass1234',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockJwt.signAsync).not.toHaveBeenCalled();
  });

  it('adminLogin rejects an admin without assigned console access before issuing tokens', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'admin',
      email: 'admin@example.com',
      passwordHash: await argon2.hash('password1'),
      status: 'ACTIVE',
      role: 'ADMIN',
    });
    mockPrisma.adminAccess.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.adminLogin({
        email: 'admin@example.com',
        password: 'password1',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(
      mockRefreshTokenService.createSessionForCurrentSingleDeviceSetting,
    ).not.toHaveBeenCalled();
    expect(mockJwt.signAsync).not.toHaveBeenCalled();
    expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'admin.login.failed' }),
    });
  });

  it('adminLogin returns issued tokens when the success audit is unavailable', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'admin',
      email: 'admin@example.com',
      passwordHash: await argon2.hash('password1'),
      status: 'ACTIVE',
      role: 'ADMIN',
    });
    mockPrisma.adminAuditLog.create.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await expect(
        service.adminLogin({
          email: 'admin@example.com',
          password: 'password1',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      );
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'admin.login.success' }),
      });
      expect(warn).toHaveBeenCalledWith(
        'Admin login success audit unavailable',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('adminLogin preserves the authentication error when the failure audit is unavailable', async () => {
    mockPrisma.adminAuditLog.create.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await expect(
        service.adminLogin({
          email: 'missing@example.com',
          password: 'password1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'admin.login.failed',
          actorID: 'anonymous',
        }),
      });
      expect(mockJwt.signAsync).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Admin login audit unavailable');
    } finally {
      warn.mockRestore();
    }
  });

  it('adminLogin replaces prior admin sessions when single-device login is enabled', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-1',
      accountId: 'admin',
      email: 'admin@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'ADMIN',
      singleDeviceLoginEnabled: true,
    });

    await service.adminLogin({
      email: 'admin@example.com',
      password: 'password1',
    } as any);

    expect(
      mockRefreshTokenService.createSessionForCurrentSingleDeviceSetting,
    ).toHaveBeenCalledWith('uuid-1', undefined, 'ADMIN');
    expect(
      mockRefreshTokenService.replaceForSingleDevice,
    ).not.toHaveBeenCalled();
    expect(mockRefreshTokenService.create).not.toHaveBeenCalled();
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
    await service.logoutAll('uuid-1', 'session-1');

    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
    expect(mockDeviceTrust.invalidateChallenges).toHaveBeenCalledWith('uuid-1');
    expect(mockDeviceTrust.revokeOtherDevices).toHaveBeenCalledWith(
      'uuid-1',
      'device-key-of-session-1',
    );
  });

  it('revokes a selected session for the current user', async () => {
    await service.logoutSession('uuid-1', 'session-2');

    expect(mockRefreshTokenService.revokeSessionFamily).toHaveBeenCalledWith(
      'uuid-1',
      'session-2',
    );
    expect(mockRefreshTokenService.revokeSession).not.toHaveBeenCalled();
    // 同一设备的其他会话一起撤，否则剩下那条续签会让设备继续在线。
    expect(mockRefreshTokenService.revokeDeviceSessions).toHaveBeenCalledWith(
      'uuid-1',
      'device-key-of-session-2',
    );
    // 移除设备 = 撤销信任，下次登录要重新经受信任设备批准。
    expect(mockDeviceTrust.revokeDevice).toHaveBeenCalledWith(
      'uuid-1',
      'device-key-of-session-2',
    );
  });

  it('revokes the whole token family when removing the current session', async () => {
    mockRefreshTokenService.findSessionDeviceKey.mockResolvedValue(
      'same-phone' as never,
    );

    await service.logoutSession('uuid-1', 'current-session', 'current-session');

    expect(mockRefreshTokenService.revokeSessionFamily).toHaveBeenCalledWith(
      'uuid-1',
      'current-session',
    );
    expect(mockRefreshTokenService.revokeSession).not.toHaveBeenCalled();
    expect(mockRefreshTokenService.revokeDeviceSessions).not.toHaveBeenCalled();
    expect(mockDeviceTrust.revokeDevice).not.toHaveBeenCalled();
  });

  it('revokes other sessions while keeping the current session', async () => {
    await service.logoutOtherSessions('uuid-1', 'session-1');

    expect(mockRefreshTokenService.revokeOtherSessions).toHaveBeenCalledWith(
      'uuid-1',
      'session-1',
    );
    expect(mockDeviceTrust.revokeOtherDevices).toHaveBeenCalledWith(
      'uuid-1',
      'device-key-of-session-1',
    );
    expect(mockDeviceTrust.invalidateChallenges).toHaveBeenCalledWith('uuid-1');
  });

  it('revokes an older selected token family while keeping the same device trusted', async () => {
    mockRefreshTokenService.findSessionDeviceKey.mockResolvedValue(
      'same-phone' as never,
    );

    await service.logoutSession('uuid-1', 'old-session', 'current-session');

    expect(mockRefreshTokenService.revokeSessionFamily).toHaveBeenCalledWith(
      'uuid-1',
      'old-session',
    );
    expect(mockRefreshTokenService.revokeSession).not.toHaveBeenCalled();
    expect(mockRefreshTokenService.revokeDeviceSessions).not.toHaveBeenCalled();
    expect(mockDeviceTrust.revokeDevice).not.toHaveBeenCalled();
    mockRefreshTokenService.findSessionDeviceKey.mockImplementation(
      (_userId: string, sessionId: string) =>
        Promise.resolve(`device-key-of-${sessionId}`),
    );
  });

  it('a wrong security code on the challenge path never touches the app-lock counters', async () => {
    const securityCodeHash = await argon2.hash('2468');
    users.push({
      id: 'uuid-sc',
      accountId: 'sc1',
      email: 'sc@example.com',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
      loginSecurityCodeHash: securityCodeHash,
      securityCodeAttempts: 0,
      securityCodeLockedUntil: null,
    });
    mockDeviceTrust.loadForSecurityCode.mockResolvedValueOnce({
      id: 'challenge-sc',
      userId: 'uuid-sc',
      deviceKey: 'new-device',
    } as never);
    mockPrisma.user.update.mockClear();

    await expect(
      service.verifyLoginChallengeSecurityCode('challenge-sc', '1357', {
        deviceKey: 'new-device',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(mockDeviceTrust.verifySecurityCodeFallback).toHaveBeenCalledWith(
      'challenge-sc',
      'new-device',
      expect.any(Function),
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('revokes all device trust when the current session has no bound device', async () => {
    mockRefreshTokenService.findSessionDeviceKey.mockResolvedValueOnce(
      null as never,
    );
    await service.logoutOtherSessions('uuid-1', 'session-1');

    expect(mockDeviceTrust.revokeOtherDevices).toHaveBeenCalledWith(
      'uuid-1',
      null,
    );
  });

  it('does not issue tokens when the device needs verification', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-new-device',
      accountId: 'newdev1',
      email: 'newdev@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });
    const expiresAt = new Date(Date.now() + 300_000);
    mockDeviceTrust.evaluateLogin.mockResolvedValueOnce({
      kind: 'challenge',
      challenge: { id: 'challenge-1', expiresAt, securityCodeAvailable: false },
    } as never);

    const result = await service.login(
      { identifier: 'newdev@example.com', password: 'password1' } as any,
      { deviceKey: 'unknown-device' },
    );

    expect(result).toEqual({
      deviceVerificationRequired: true,
      challenge: { id: 'challenge-1', expiresAt, securityCodeAvailable: false },
    });
    expect(mockRefreshTokenService.createAppSession).not.toHaveBeenCalled();
    expect(mockJwt.signAsync).not.toHaveBeenCalled();
  });

  it('completes a matured recovery: trusts this device, issues tokens, then revokes everything else', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-recover',
      accountId: 'recover1',
      email: 'recover@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });
    mockDeviceTrust.evaluateLogin.mockResolvedValueOnce({
      kind: 'recovered',
      challengeId: 'challenge-r',
    } as never);
    const order: string[] = [];
    mockRefreshTokenService.createAppSession.mockImplementationOnce(
      async () => {
        order.push('issue');
        return { token: 'refresh-token', sessionId: 'session-new' };
      },
    );
    mockRefreshTokenService.revokeOtherSessions.mockImplementationOnce(
      async () => {
        order.push('revoke-sessions');
      },
    );

    const result = await service.login(
      { identifier: 'recover@example.com', password: 'password1' } as any,
      { deviceKey: 'reinstalled', deviceName: 'SM-F9360' },
    );

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(mockDeviceTrust.trust).toHaveBeenCalledWith(
      'uuid-recover',
      'reinstalled',
      expect.objectContaining({ deviceKey: 'reinstalled' }),
    );
    // 先发后撤：撤销写的吊销边界不能盖住同一毫秒签发的新 token。
    expect(order).toEqual(['issue', 'revoke-sessions']);
    expect(mockRefreshTokenService.revokeOtherSessions).toHaveBeenCalledWith(
      'uuid-recover',
      'session-new',
    );
    expect(mockDeviceTrust.revokeOtherDevices).toHaveBeenCalledWith(
      'uuid-recover',
      'reinstalled',
    );
    expect(mockDeviceTrust.invalidateChallenges).toHaveBeenCalledWith(
      'uuid-recover',
    );
  });

  it('a failure midway through recovery hands the claim back so a retry runs it fully', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-recover-fail',
      accountId: 'recoverfail',
      email: 'recover-fail@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });
    mockDeviceTrust.evaluateLogin.mockResolvedValueOnce({
      kind: 'recovered',
      challengeId: 'challenge-r',
    } as never);
    mockDeviceTrust.revokeOtherDevices.mockRejectedValueOnce(
      new Error('database unavailable') as never,
    );

    await expect(
      service.login(
        {
          identifier: 'recover-fail@example.com',
          password: 'password1',
        } as any,
        { deviceKey: 'reinstalled' },
      ),
    ).rejects.toThrow('database unavailable');
    expect(mockDeviceTrust.releaseRecoveryClaim).toHaveBeenCalledWith(
      'challenge-r',
    );
    expect(mockDeviceTrust.trust).not.toHaveBeenCalled();
  });

  it('requesting recovery answers with the waiting deadline', async () => {
    const recoveryAvailableAt = new Date(Date.now() + 86_400_000);
    mockDeviceTrust.requestRecovery.mockResolvedValueOnce({
      id: 'challenge-r',
      expiresAt: new Date(recoveryAvailableAt.getTime() + 1000),
      securityCodeAvailable: false,
      recoveryAvailableAt,
    } as never);

    await expect(
      service.requestLoginRecovery('challenge-r', 'reinstalled'),
    ).resolves.toEqual({
      deviceVerificationRequired: true,
      challenge: expect.objectContaining({
        id: 'challenge-r',
        recoveryAvailableAt,
      }),
    });
  });

  it('never evaluates device trust when the password is wrong', async () => {
    const passwordHash = await argon2.hash('password1');
    users.push({
      id: 'uuid-wrong-pw',
      accountId: 'wrongpw1',
      email: 'wrongpw@example.com',
      passwordHash,
      status: 'ACTIVE',
      role: 'USER',
    });
    await expect(
      service.login({
        identifier: 'wrongpw@example.com',
        password: 'password2',
      } as any),
    ).rejects.toThrow(ForbiddenException);
    // 错密码不能触发受信任设备弹窗，否则谁都能拿别人的账号名刷弹窗。
    expect(mockDeviceTrust.evaluateLogin).not.toHaveBeenCalled();
  });

  it('serializes challenge completion through token issuance before recovery', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });
    let consumed!: () => void;
    const consumedBarrier = new Promise<void>((resolve) => {
      consumed = resolve;
    });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDeviceTrust.consumeWithCode.mockImplementationOnce(async () => {
      consumed();
      await pause;
      return { userId: 'uuid-1', deviceKey: 'new-device' };
    });
    const original = mockPrisma.$transaction.getMockImplementation();
    let queue: Promise<unknown> = Promise.resolve();
    mockPrisma.$transaction.mockImplementation((operation: any) => {
      const task = queue.then(() => operation(mockPrisma));
      queue = task.catch(() => {});
      return task;
    });
    try {
      const login = service.verifyLoginChallengeCode('challenge', '123456', {
        deviceKey: 'new-device',
      });
      await consumedBarrier;
      const recovery = service.logoutAll('uuid-1');
      await Promise.resolve();
      expect(mockDeviceTrust.invalidateChallenges).not.toHaveBeenCalled();
      release();
      await Promise.all([login, recovery]);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(
        mockRefreshTokenService.createAppSession.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockRefreshTokenService.revokeAll.mock.invocationCallOrder[0],
      );
    } finally {
      mockPrisma.$transaction.mockImplementation(original!);
    }
  });

  it('does not evaluate trusted login until overlapping device removal has finished', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'aaa111',
      passwordHash: await argon2.hash('password1'),
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });
    let removing!: () => void;
    const started = new Promise<void>((resolve) => {
      removing = resolve;
    });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockRefreshTokenService.findSessionDeviceKey.mockResolvedValue('removed');
    mockRefreshTokenService.revokeSessionFamily.mockImplementationOnce(
      async () => {
        removing();
        await pause;
      },
    );
    const original = mockPrisma.$transaction.getMockImplementation();
    let queue: Promise<unknown> = Promise.resolve();
    mockPrisma.$transaction.mockImplementation((operation: any) => {
      const task = queue.then(() => operation(mockPrisma));
      queue = task.catch(() => {});
      return task;
    });
    mockDeviceTrust.evaluateLogin.mockResolvedValueOnce({
      kind: 'challenge',
      challenge: {
        id: 'new',
        expiresAt: new Date().toISOString(),
        securityCodeAvailable: false,
      },
    } as never);
    try {
      const removal = service.logoutSession('uuid-1', 'other');
      await started;
      const login = service.login(
        { identifier: 'AAA111', password: 'password1' },
        {
          deviceKey: 'removed',
        },
      );
      await new Promise(setImmediate);
      expect(mockDeviceTrust.evaluateLogin).not.toHaveBeenCalled();
      release();
      await removal;
      const result = await login;
      expect(result).toHaveProperty('deviceVerificationRequired', true);
      expect(
        mockDeviceTrust.revokeDevice.mock.invocationCallOrder[0],
      ).toBeLessThan(mockDeviceTrust.evaluateLogin.mock.invocationCallOrder[0]);
    } finally {
      mockPrisma.$transaction.mockImplementation(original!);
    }
  });

  it('issues tokens and trusts the device after a correct challenge code', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'AAA111',
      email: 'a@example.com',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
      singleDeviceLoginEnabled: false,
    });
    mockDeviceTrust.consumeWithCode.mockResolvedValueOnce({
      userId: 'uuid-1',
      deviceKey: 'new-device',
    } as never);

    const result = await service.verifyLoginChallengeCode(
      'challenge-1',
      '123456',
      { deviceKey: 'new-device', deviceName: 'Pixel 9' },
    );

    expect(result.accessToken).toBe('access-token');
    expect(mockDeviceTrust.completeVerifiedLogin).toHaveBeenCalledWith(
      'uuid-1',
      'challenge-1',
      'new-device',
      { deviceKey: 'new-device', deviceName: 'Pixel 9' },
    );
    expect(mockRefreshTokenService.createAppSession).toHaveBeenCalledWith(
      'uuid-1',
      expect.objectContaining({ deviceKey: 'new-device' }),
    );
  });

  it('refuses a verified challenge for a user banned meanwhile', async () => {
    users.push({
      id: 'uuid-banned',
      accountId: 'banned1',
      email: 'banned@example.com',
      passwordHash: 'x',
      status: 'BANNED',
      role: 'USER',
    });
    mockDeviceTrust.consumeWithCode.mockResolvedValueOnce({
      userId: 'uuid-banned',
      deviceKey: 'new-device',
    } as never);

    await expect(
      service.verifyLoginChallengeCode('challenge-1', '123456', {
        deviceKey: 'new-device',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockDeviceTrust.completeVerifiedLogin).not.toHaveBeenCalled();
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

    expect(mockRefreshTokenService.setSingleDeviceLogin).toHaveBeenCalledWith(
      'uuid-1',
      true,
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

    expect((result as { accessToken: string }).accessToken).toBe(
      'access-token',
    );
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(mockRefreshTokenService.rotate).toHaveBeenCalledWith(
      'refresh-token',
      undefined,
      'APP',
    );
    expect(mockJwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'uuid-1', sid: 'session-2', aud: 'APP' }),
    );
    expect(mockRefreshTokenService.assertSessionActive).toHaveBeenCalledWith(
      'uuid-1',
      'session-2',
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
    // A plain USER session is never revoked by the role gate below.
    expect(mockRefreshTokenService.revokeAll).not.toHaveBeenCalled();
  });

  it('a refresh from a trusted device cancels pending recovery requests', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      lastOnline: null,
    });
    mockRefreshTokenService.rotate.mockResolvedValueOnce({
      token: 'new-refresh-token',
      userId: 'uuid-1',
      sessionId: 'session-2',
      deviceKey: 'owner-phone',
    } as never);

    await service.refresh('refresh-token');

    expect(mockDeviceTrust.isTrusted).toHaveBeenCalledWith(
      'uuid-1',
      'owner-phone',
    );
    expect(
      mockDeviceTrust.cancelRecoveriesForActiveDevice,
    ).toHaveBeenCalledWith('uuid-1', 'owner-phone');
  });

  it('a failing recovery cancellation never breaks the refresh (the token is already rotated)', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      lastOnline: null,
    });
    mockRefreshTokenService.rotate.mockResolvedValueOnce({
      token: 'new-refresh-token',
      userId: 'uuid-1',
      sessionId: 'session-2',
      deviceKey: 'owner-phone',
    } as never);
    mockDeviceTrust.cancelRecoveriesForActiveDevice.mockRejectedValueOnce(
      new Error('database unavailable') as never,
    );

    await expect(service.refresh('refresh-token')).resolves.toEqual(
      expect.objectContaining({ refreshToken: 'new-refresh-token' }),
    );
  });

  it('a refresh from an untrusted session does not cancel recovery', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'USER',
      lastOnline: null,
    });
    mockRefreshTokenService.rotate.mockResolvedValueOnce({
      token: 'new-refresh-token',
      userId: 'uuid-1',
      sessionId: 'session-2',
      deviceKey: 'revoked-phone',
    } as never);
    mockDeviceTrust.isTrusted.mockResolvedValueOnce(false as never);

    await service.refresh('refresh-token');

    expect(
      mockDeviceTrust.cancelRecoveriesForActiveDevice,
    ).not.toHaveBeenCalled();
  });

  it('refresh rejects ADMIN accounts on the APP audience and revokes their sessions', async () => {
    // 晋升成 ADMIN 之前签发的 APP refresh token 否则会一直续签出 role=ADMIN 的
    // APP access token，绕开 /auth/admin/* 的短 TTL 与审计模型。拒绝文案与 login()
    // 对 ADMIN 账号的处理完全一致，不给「这是管理员账号」的探测器。
    users.push({
      id: 'uuid-1',
      accountId: 'admin',
      passwordHash: 'hash',
      status: 'ACTIVE',
      role: 'ADMIN',
      lastOnline: null,
    });

    const error: unknown = await service
      .refresh('refresh-token')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      message: '邮箱、用户ID或密码错误',
      errorCode: AuthErrorCode.InvalidCredentials,
    });
    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
    expect(mockJwt.signAsync).not.toHaveBeenCalled();
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
      // #91：ADMIN audience 使用独立的更短 access TTL（默认 15m）
      // 秒数：min(admin 15m, 全局 1h) —— TTL 钳制后签名参数为秒
      expect.objectContaining({ expiresIn: 900 }),
    );
    expect(mockRefreshTokenService.assertSessionActive).toHaveBeenCalledWith(
      'uuid-1',
      'session-2',
    );
  });

  it('returns stored and effective membership state in the self profile response', async () => {
    const vipExpiresAt = new Date(Date.now() - 1);
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
      vipExpiresAt,
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
        vipExpiresAt: true,
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
      // 存量 vipLevel=3 但已过期：对外只给有效档位。
      vipLevel: 0,
      vipExpiresAt,
      creditScore: 128,
    });
    // SelfUserDto 早已不暴露 storedVipLevel / membership（App 与管理台都不读），
    // me() 不再为它们多算一遍会员外观。
    expect(me).not.toHaveProperty('storedVipLevel');
    expect(me).not.toHaveProperty('membership');
    expect(me.lastOnline).toBeInstanceOf(Date);
    expect(me.lastOnline.getTime()).toBeGreaterThanOrEqual(beforeMe);
  });

  it('includes the effective avatar-frame appearance in /auth/me', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'testuser',
      nickname: 'Test User',
      avatarUrl: null,
      avatarFrame: 'legacy-frame',
      vipLevel: 0,
      vipExpiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockAvatarFrameService.resolvePublicAppearances.mockResolvedValue(
      new Map([
        [
          'uuid-1',
          {
            vipLevel: 0,
            avatarFrame: {
              id: 'frame-1',
              key: 'admin-gift',
              name: 'Gift frame',
              imageUrl: null,
            },
          },
        ],
      ]),
    );

    await expect(service.me('uuid-1')).resolves.toMatchObject({
      avatarFrame: 'legacy-frame',
      avatarFrameAppearance: {
        id: 'frame-1',
        key: 'admin-gift',
        name: 'Gift frame',
        imageUrl: null,
      },
    });
    expect(
      mockAvatarFrameService.resolvePublicAppearances,
    ).toHaveBeenCalledWith(['uuid-1']);
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
    ).rejects.toThrow(/邮箱、用户ID或密码错误/);
    await expect(
      service.login({
        email: 'nosuch@example.com',
        password: 'password1',
      } as any),
    ).rejects.toThrow(/邮箱、用户ID或密码错误/);
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

    await service.changePassword(
      'uuid-1',
      'current-password',
      'new-password',
      'session-1',
    );

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'uuid-1' },
        data: expect.objectContaining({
          passwordHash: expect.any(String),
        }),
      }),
    );
    expect(mockRefreshTokenService.revokeAll).toHaveBeenCalledWith('uuid-1');
    // 改密 = 怀疑泄露：只保留发起改密的这台设备的信任，进行中的验证单作废。
    expect(mockDeviceTrust.revokeOtherDevices).toHaveBeenCalledWith(
      'uuid-1',
      'device-key-of-session-1',
    );
    expect(mockDeviceTrust.invalidateChallenges).toHaveBeenCalledWith('uuid-1');
  });

  it('password reset by email revokes all device trust (lost-device recovery)', async () => {
    users.push({
      id: 'uuid-reset',
      accountId: 'resetme',
      email: 'reset@example.com',
      passwordHash: 'x',
      status: 'ACTIVE',
      role: 'USER',
    });
    const prismaAny = mockPrisma as any;
    const original = {
      transaction: prismaAny.$transaction,
      refreshToken: prismaAny.refreshToken,
    };
    prismaAny.$transaction = jest.fn(async (operation: any) =>
      typeof operation === 'function'
        ? operation(prismaAny)
        : Promise.all(operation),
    );
    prismaAny.refreshToken = { updateMany: jest.fn() };
    (mockRefreshTokenService as any).revokeAllAccessMarkers = jest.fn(() =>
      Promise.resolve(),
    );

    try {
      await service.resetPassword(
        'reset@example.com',
        '123456',
        'new-password',
      );
    } finally {
      prismaAny.$transaction = original.transaction;
      prismaAny.refreshToken = original.refreshToken;
    }

    // 全部撤销后，下一次登录的设备按「首台设备」处理，不必再等丢了的手机批准。
    expect(mockDeviceTrust.revokeOtherDevices).toHaveBeenCalledWith(
      'uuid-reset',
      null,
    );
    expect(mockDeviceTrust.invalidateChallenges).toHaveBeenCalledWith(
      'uuid-reset',
    );
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

  it('changeAccountId rejects changes while the current fancy number is active', async () => {
    users.push({
      id: 'uuid-1',
      accountId: '888888',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockFancyNumberService.ensureAccountIdChangeAllowed.mockRejectedValueOnce(
      new ConflictException('Active fancy number'),
    );

    await expect(
      service.changeAccountId('uuid-1', 'alice_2024'),
    ).rejects.toThrow(ConflictException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('changeAccountId rejects a fancy-number purchase that wins the user lock after the pre-check', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockPrisma.fancyNumberLease.findFirst.mockResolvedValueOnce({
      id: 'lease-created-concurrently',
    });

    await expect(
      service.changeAccountId('uuid-1', 'alice_2024'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_ACCOUNT_ID_LOCKED',
      }),
    });
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
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

  it('changeAccountId rejects a number reserved in fancy-number inventory', async () => {
    users.push({
      id: 'uuid-1',
      accountId: 'alice',
      email: 'alice@test.dev',
      status: 'ACTIVE',
      role: 'USER',
    });
    mockPrisma.accountIdentifier.findUnique.mockResolvedValueOnce({
      value: '888888',
      currentUserID: null,
      reservedForUserID: null,
      inviteOwnerUserID: null,
      fancyNumber: { id: 'fancy-1' },
    });

    await expect(service.changeAccountId('uuid-1', '888888')).rejects.toThrow(
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
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockPrisma.fancyNumberLease.findFirst).toHaveBeenCalledWith({
      where: { userID: 'uuid-1', endedAt: null },
      select: { id: true },
    });
    expect(mockPrisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.fancyNumberLease.findFirst.mock.invocationCallOrder[0],
    );
    expect(
      mockPrisma.fancyNumberLease.findFirst.mock.invocationCallOrder[0],
    ).toBeLessThan(mockPrisma.user.update.mock.invocationCallOrder[0]);
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
        title: 'VIP4',
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
      vipLevel: 4,
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
        title: 'VIP4',
      }),
    ]);
  });
});
