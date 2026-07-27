import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembershipProgramService } from './membership-program.service';

describe('MembershipProgramService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback) => callback(tx)),
  };
  const service = new MembershipProgramService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('defaults to disabled with a gold entitlement floor before rollout', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(service.getStatus()).resolves.toEqual({
      enabled: false,
      enabledAt: null,
      enabledByUserId: null,
      entitlementFloorLevel: 2,
    });
  });

  it('enables once under a database lock and records the operator', async () => {
    const enabledAt = new Date('2026-08-01T00:00:00.000Z');
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ enabledAt, enabledByUserId: 'admin-1' }]);
    tx.$executeRaw.mockResolvedValue(1);

    await expect(service.enable('admin-1')).resolves.toEqual({
      replayed: false,
      status: {
        enabled: true,
        enabledAt,
        enabledByUserId: 'admin-1',
        entitlementFloorLevel: 0,
      },
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const lock = tx.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(lock.sql).toContain('pg_advisory_xact_lock');
  });

  it('is idempotent after activation and preserves the original operator', async () => {
    const enabledAt = new Date('2026-08-01T00:00:00.000Z');
    tx.$queryRaw.mockResolvedValue([
      { enabledAt, enabledByUserId: 'admin-original' },
    ]);

    await expect(service.enable('admin-retry')).resolves.toEqual({
      replayed: true,
      status: {
        enabled: true,
        enabledAt,
        enabledByUserId: 'admin-original',
        entitlementFloorLevel: 0,
      },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
