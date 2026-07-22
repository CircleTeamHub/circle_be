import { ConfigService } from '@nestjs/config';
import {
  parseRefreshTtlMs,
  RefreshTokenService,
} from './refresh-token.service';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function serviceWith(env: Record<string, string | number | undefined>) {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  const prisma = { refreshToken: { create: jest.fn() } };
  const revocation = { revokeSession: jest.fn(), revokeUser: jest.fn() };
  return new RefreshTokenService(prisma as never, config, revocation as never);
}

describe('parseRefreshTtlMs (#84)', () => {
  it('parses d/h/m suffixes and bare numbers (legacy days semantics)', () => {
    expect(parseRefreshTtlMs('30d')).toBe(30 * DAY);
    expect(parseRefreshTtlMs('12h')).toBe(12 * HOUR);
    expect(parseRefreshTtlMs('45m')).toBe(45 * 60_000);
    expect(parseRefreshTtlMs('14')).toBe(14 * DAY);
    expect(parseRefreshTtlMs(7)).toBe(7 * DAY);
  });

  it('rejects garbage instead of silently defaulting', () => {
    expect(parseRefreshTtlMs('soon')).toBeNull();
    expect(parseRefreshTtlMs('')).toBeNull();
    expect(parseRefreshTtlMs('-3d')).toBeNull();
    expect(parseRefreshTtlMs('0d')).toBeNull();
    expect(parseRefreshTtlMs(undefined)).toBeNull();
  });
});

describe('RefreshTokenService TTL wiring (#84 #91)', () => {
  it('honours the documented REFRESH_EXPIRES_IN knob', () => {
    const service = serviceWith({ REFRESH_EXPIRES_IN: '30d' });
    expect(service.ttlMsFor('APP')).toBe(30 * DAY);
  });

  it('falls back to the legacy REFRESH_EXPIRES_IN_DAYS knob', () => {
    const service = serviceWith({ REFRESH_EXPIRES_IN_DAYS: '14' });
    expect(service.ttlMsFor('APP')).toBe(14 * DAY);
  });

  it('defaults to 7d when nothing (valid) is configured — no silent extension', () => {
    expect(serviceWith({}).ttlMsFor('APP')).toBe(7 * DAY);
    expect(serviceWith({ REFRESH_EXPIRES_IN: 'garbage' }).ttlMsFor('APP')).toBe(
      7 * DAY,
    );
  });

  it('gives ADMIN audience its own shorter TTL (default 12h)', () => {
    const service = serviceWith({ REFRESH_EXPIRES_IN: '30d' });
    expect(service.ttlMsFor('ADMIN')).toBe(12 * HOUR);
  });

  it('clamps ADMIN TTL to never exceed the user TTL', () => {
    const service = serviceWith({
      REFRESH_EXPIRES_IN: '6h',
      ADMIN_REFRESH_EXPIRES_IN: '10d',
    });
    expect(service.ttlMsFor('ADMIN')).toBe(6 * HOUR);
  });

  it('writes the configured TTL into expiredAt on create (#84 regression)', async () => {
    const created: { data?: { expiredAt: Date } }[] = [];
    const config = {
      get: (key: string) => (key === 'REFRESH_EXPIRES_IN' ? '30d' : undefined),
    } as unknown as ConfigService;
    const prisma = {
      refreshToken: {
        create: jest.fn((args: { data: { expiredAt: Date } }) => {
          created.push(args);
          return Promise.resolve({ id: 'session-1' });
        }),
      },
    };
    const service = new RefreshTokenService(prisma as never, config, {
      revokeSession: jest.fn(),
      revokeUser: jest.fn(),
    } as never);

    const before = Date.now();
    await service.create('user-1');
    const expiredAt = created[0].data!.expiredAt.getTime();

    // 允许执行耗时的少量抖动
    expect(expiredAt - before).toBeGreaterThan(30 * DAY - 5_000);
    expect(expiredAt - before).toBeLessThan(30 * DAY + 5_000);
  });

  it('revoke() only attributes the session when a row was actually revoked (double-logout)', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const revocation = { revokeSession: jest.fn(), revokeUser: jest.fn() };
    let alreadyRevoked = false;
    const prisma = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'session-1',
          userId: 'admin-1',
          audience: 'ADMIN',
        }),
        updateMany: jest.fn(() =>
          // 第一次撤销 1 行；重放（超时重试/旧 token）撤销 0 行
          Promise.resolve({
            count: alreadyRevoked ? 0 : ((alreadyRevoked = true), 1),
          }),
        ),
      },
    };
    const service = new RefreshTokenService(
      prisma as never,
      config,
      revocation as never,
    );

    // 首次登出：真撤销，返回归属+会话 id 供审计
    await expect(service.revoke('token-x')).resolves.toEqual({
      userId: 'admin-1',
      audience: 'ADMIN',
      sessionId: 'session-1',
    });
    // 重放：行早已撤销 —— 不返回归属，调用方不得再记一条成功审计。
    // round 3 起吊销标记只要行存在就写（幂等），所以标记会再写一次，
    // 变化的只是归属/审计不再返回。
    await expect(service.revoke('token-x')).resolves.toBeNull();
    expect(revocation.revokeSession).toHaveBeenCalledTimes(2);
    expect(revocation.revokeSession).toHaveBeenNthCalledWith(2, 'session-1');
  });

  it('revoke() ignores expired-but-never-revoked tokens (no phantom logout audit)', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const revocation = { revokeSession: jest.fn(), revokeUser: jest.fn() };
    const prisma = {
      refreshToken: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'session-old',
          userId: 'admin-1',
          audience: 'ADMIN',
        }),
        // where 带 expiredAt > now：过期行匹配 0 条
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const service = new RefreshTokenService(
      prisma as never,
      config,
      revocation as never,
    );

    await expect(service.revoke('expired-token')).resolves.toBeNull();
    // round 3：行存在（即使过期）就写吊销标记 —— refresh TTL 可短于
    // access TTL，登出必须让还活着的 access token 立即失效
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-old');
    // 撤销条件必须显式排除过期行
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expiredAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });
});
