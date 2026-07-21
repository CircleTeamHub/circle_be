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
});
