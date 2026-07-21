import { ForbiddenException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('argon2', () => ({
  verify: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const argon2 = require('argon2') as { verify: jest.Mock };

type UserRow = {
  id: string;
  email: string;
  status: string;
  role: string;
  passwordHash: string;
  adminLoginAttempts: number;
  adminLoginLockedUntil: Date | null;
  singleDeviceLoginEnabled: boolean;
  accountId: string;
};

function buildService(user: UserRow | null) {
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn(
        (args: { where: unknown; data: Record<string, unknown> }) => {
          updates.push(args);
          return Promise.resolve({});
        },
      ),
    },
  };
  const refreshTokenService = {
    create: jest.fn().mockResolvedValue({ token: 'r', sessionId: 's1' }),
    revokeAll: jest.fn(),
    revoke: jest.fn(),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('jwt') };
  const openim = { getUserToken: jest.fn().mockResolvedValue('im') };
  const config = { get: jest.fn().mockReturnValue(undefined) };

  const service = new AuthService(
    prisma as never,
    refreshTokenService as never,
    jwt as never,
    openim as never,
    { listForUser: jest.fn() } as never,
    { verifyCode: jest.fn() } as never,
    config as never,
  );
  return { service, prisma, updates, jwt };
}

function adminUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'admin-1',
    email: 'admin@example.com',
    status: 'ACTIVE',
    role: 'ADMIN',
    passwordHash: 'hash',
    adminLoginAttempts: 0,
    adminLoginLockedUntil: null,
    singleDeviceLoginEnabled: false,
    accountId: 'acc-1',
    ...overrides,
  };
}

describe('admin login lockout (#83)', () => {
  beforeEach(() => {
    argon2.verify.mockReset();
  });

  it('increments the failed counter on a wrong password', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, updates } = buildService(adminUser());

    await expect(
      service.adminLogin({ email: 'admin@example.com', password: 'nope' }),
    ).rejects.toThrow(ForbiddenException);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ adminLoginAttempts: 1 });
    expect(updates[0].data.adminLoginLockedUntil).toBeNull();
  });

  it('locks the account on the 5th consecutive failure', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, updates } = buildService(
      adminUser({ adminLoginAttempts: 4 }),
    );

    await expect(
      service.adminLogin({ email: 'admin@example.com', password: 'nope' }),
    ).rejects.toThrow(ForbiddenException);

    expect(updates).toHaveLength(1);
    expect(updates[0].data.adminLoginAttempts).toBe(0);
    expect(updates[0].data.adminLoginLockedUntil).toBeInstanceOf(Date);
    const lockedUntil = updates[0].data.adminLoginLockedUntil as Date;
    expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects while locked WITHOUT running the password check', async () => {
    const { service } = buildService(
      adminUser({
        adminLoginLockedUntil: new Date(Date.now() + 10 * 60_000),
      }),
    );

    await expect(
      service.adminLogin({ email: 'admin@example.com', password: 'right' }),
    ).rejects.toThrow(ForbiddenException);
    expect(argon2.verify).not.toHaveBeenCalled();
  });

  it('resets the counter and logs in after the lock expires', async () => {
    argon2.verify.mockResolvedValue(true);
    const { service, updates } = buildService(
      adminUser({
        adminLoginAttempts: 3,
        adminLoginLockedUntil: new Date(Date.now() - 1_000),
      }),
    );

    const tokens = await service.adminLogin({
      email: 'admin@example.com',
      password: 'right',
    });

    expect(tokens.accessToken).toBe('jwt');
    const resetWrite = updates.find(
      (u) =>
        u.data.adminLoginAttempts === 0 &&
        u.data.adminLoginLockedUntil === null,
    );
    expect(resetWrite).toBeDefined();
  });

  it('does NOT count failures against non-admin accounts (no DoS lever)', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, updates } = buildService(adminUser({ role: 'USER' }));

    await expect(
      service.adminLogin({ email: 'admin@example.com', password: 'nope' }),
    ).rejects.toThrow(ForbiddenException);

    expect(updates.filter((u) => 'adminLoginAttempts' in u.data)).toHaveLength(
      0,
    );
  });

  it('signs admin access tokens with the shorter admin expiry (#91)', async () => {
    argon2.verify.mockResolvedValue(true);
    const { service, jwt } = buildService(adminUser());

    await service.adminLogin({
      email: 'admin@example.com',
      password: 'right',
    });

    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ aud: 'ADMIN' }),
      expect.objectContaining({ expiresIn: '15m' }),
    );
  });
});
