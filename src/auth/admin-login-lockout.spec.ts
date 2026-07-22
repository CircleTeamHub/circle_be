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
  const updateManyCalls: { where: any; data: Record<string, unknown> }[] = [];
  // 模拟 DB 侧真实语义：increment 相对写 + updateMany 条件匹配。这正是原子
  // 方案的关键 —— 服务不再信任读到的快照，而是让 DB 决定是否到达锁定阈值。
  const counter = { attempts: user?.adminLoginAttempts ?? 0 };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn((args: { where: unknown; data: Record<string, any> }) => {
        updates.push(args);
        const inc = args.data?.adminLoginAttempts?.increment;
        if (typeof inc === 'number') counter.attempts += inc;
        return Promise.resolve({});
      }),
      updateMany: jest.fn(
        (args: { where: any; data: Record<string, unknown> }) => {
          updateManyCalls.push(args);
          const gte = args.where?.adminLoginAttempts?.gte;
          if (typeof gte === 'number' && counter.attempts >= gte) {
            counter.attempts = 0;
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
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
  return { service, prisma, updates, updateManyCalls, counter, jwt };
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

  it('counts failures with a DB-side atomic increment (not read-modify-write)', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, updates, updateManyCalls, counter } =
      buildService(adminUser());

    await expect(
      service.adminLogin({ email: 'admin@example.com', password: 'nope' }),
    ).rejects.toThrow(ForbiddenException);

    // 相对写：{ increment: 1 }，绝不回写读到的快照值
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ adminLoginAttempts: { increment: 1 } });
    expect(counter.attempts).toBe(1);
    // 锁定转换是条件 updateMany（阈值未到 → 0 行，不上锁）
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].where.adminLoginAttempts).toEqual({ gte: 5 });
  });

  it('locks the account on the 5th consecutive failure', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, updateManyCalls, counter } = buildService(
      adminUser({ adminLoginAttempts: 4 }),
    );

    await expect(
      service.adminLogin({ email: 'admin@example.com', password: 'nope' }),
    ).rejects.toThrow(ForbiddenException);

    expect(counter.attempts).toBe(0); // 锁定时清零
    const lockWrite = updateManyCalls[0];
    expect(lockWrite.data.adminLoginAttempts).toBe(0);
    expect(lockWrite.data.adminLoginLockedUntil).toBeInstanceOf(Date);
    expect(
      (lockWrite.data.adminLoginLockedUntil as Date).getTime(),
    ).toBeGreaterThan(Date.now());
  });

  it('locks after 5 CONCURRENT wrong guesses that all read the same stale row', async () => {
    argon2.verify.mockResolvedValue(false);
    // findUnique 恒返回 attempts=0 的旧快照 —— 分布式撞库场景。旧读-改-写
    // 实现下 5 发并发只能把计数推到 1；原子 increment 下 DB 计数真实到 5。
    const { service, counter, updateManyCalls } = buildService(adminUser());

    await Promise.all(
      Array.from({ length: 5 }, () =>
        service
          .adminLogin({ email: 'admin@example.com', password: 'nope' })
          .catch(() => undefined),
      ),
    );

    // 第 5 次 increment 后条件转换命中：锁上且计数清零
    const lockHits = updateManyCalls.filter(
      (c) => c.where.adminLoginAttempts?.gte === 5,
    );
    expect(lockHits).toHaveLength(5);
    expect(counter.attempts).toBe(0);
    const lockedWrites = lockHits.filter(
      (c) => c.data.adminLoginLockedUntil instanceof Date,
    );
    expect(lockedWrites.length).toBeGreaterThan(0);
  });

  it('locks the admin after 5 wrong passwords on the REGULAR /auth/login route (round 2 P1)', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, counter, updateManyCalls } = buildService(adminUser());

    for (let i = 0; i < 5; i += 1) {
      await service
        .login({ email: 'admin@example.com', password: 'nope' })
        .catch(() => undefined);
    }

    // 与 adminLogin 共用同一原子计数：第 5 次触发条件上锁
    expect(counter.attempts).toBe(0); // 上锁时清零
    const lockedWrites = updateManyCalls.filter(
      (c) => c.data.adminLoginLockedUntil instanceof Date,
    );
    expect(lockedWrites.length).toBeGreaterThan(0);
  });

  it('rejects an ADMIN with VALID credentials on /auth/login (round 3 P1)', async () => {
    argon2.verify.mockResolvedValue(true);
    const { service, updates } = buildService(
      adminUser({ adminLoginAttempts: 2 }),
    );

    // 密码对了也不放行：普通登录发的是 APP audience 长会话 + IM token，
    // 会被 /roles 等管理端点接受，绕开短 TTL 管理会话模型
    await expect(
      service.login({ email: 'admin@example.com', password: 'right' }),
    ).rejects.toThrow(ForbiddenException);
    // 有效凭据仍清零锁定计数（证明不是撞库）
    const resetWrite = updates.find(
      (u) =>
        u.data.adminLoginAttempts === 0 &&
        u.data.adminLoginLockedUntil === null,
    );
    expect(resetWrite).toBeDefined();
  });

  it('rejects a locked admin on /auth/login without running argon2 (round 2 P1)', async () => {
    const { service } = buildService(
      adminUser({
        adminLoginLockedUntil: new Date(Date.now() + 10 * 60_000),
      }),
    );

    await expect(
      service.login({ email: 'admin@example.com', password: 'right' }),
    ).rejects.toThrow(ForbiddenException);
    expect(argon2.verify).not.toHaveBeenCalled();
  });

  it('does NOT touch lockout counters for regular USER logins (round 2)', async () => {
    argon2.verify.mockResolvedValue(false);
    const { service, updates } = buildService(adminUser({ role: 'USER' }));

    await expect(
      service.login({ email: 'admin@example.com', password: 'nope' }),
    ).rejects.toThrow(ForbiddenException);

    expect(updates.filter((u) => 'adminLoginAttempts' in u.data)).toHaveLength(
      0,
    );
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
      // 秒数：min(ADMIN_JWT_EXPIRES_IN 默认 15m, JWT_EXPIRES_IN 默认 1h)
      expect.objectContaining({ expiresIn: 15 * 60 }),
    );
  });

  it('clamps admin access TTL to JWT_EXPIRES_IN so revocation markers outlive tokens', async () => {
    argon2.verify.mockResolvedValue(true);
    const { service, jwt } = buildService(adminUser());
    // ADMIN_JWT_EXPIRES_IN 配得比全局长：吊销标记按全局 TTL 定长，admin token
    // 更长会在标记过期后「复活」——必须钳到全局值。
    const ttlEnv: Record<string, string> = {
      ADMIN_JWT_EXPIRES_IN: '2h',
      JWT_EXPIRES_IN: '1h',
    };
    const configGet = (
      service as unknown as {
        configService: { get: jest.Mock };
      }
    ).configService.get;
    configGet.mockImplementation((key: string) => ttlEnv[key]);

    await service.adminLogin({
      email: 'admin@example.com',
      password: 'right',
    });

    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ aud: 'ADMIN' }),
      expect.objectContaining({ expiresIn: 60 * 60 }),
    );
  });
});
