import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MembershipPolicyService,
  MembershipQuota,
} from './membership-policy.service';
import { MembershipProgramService } from './membership-program.service';

describe('MembershipPolicyService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
  };
  const service = new MembershipPolicyService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('reads only membership fields and resolves an expired user to regular', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: new Date('2026-07-21T11:59:59.999Z'),
    });

    const policy = await service.getUserPolicy(
      'user-1',
      new Date('2026-07-21T12:00:00.000Z'),
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { vipLevel: true, vipExpiresAt: true },
    });
    expect(policy.level).toBe(0);
    expect(policy.tier.key).toBe('regular');
  });

  it('fails explicitly when the user does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getUserPolicy('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('uses gold as the entitlement floor while the program is disabled', async () => {
    const program = {
      getStatus: jest.fn().mockResolvedValue({ enabled: false }),
    };
    const rolloutService = new MembershipPolicyService(
      prisma as unknown as PrismaService,
      program as unknown as MembershipProgramService,
    );

    const regular = await rolloutService.resolveEntitlement({
      vipLevel: 0,
      vipExpiresAt: null,
    });
    const superMember = await rolloutService.resolveEntitlement({
      vipLevel: 4,
      vipExpiresAt: null,
    });

    expect(regular.level).toBe(2);
    expect(regular.tier.key).toBe('gold');
    expect(superMember.level).toBe(4);
    expect(superMember.tier.key).toBe('super');
  });

  it('uses the real effective tier after the program is enabled', async () => {
    const program = {
      getStatus: jest.fn().mockResolvedValue({ enabled: true }),
    };
    const rolloutService = new MembershipPolicyService(
      prisma as unknown as PrismaService,
      program as unknown as MembershipProgramService,
    );

    const policy = await rolloutService.resolveEntitlement({
      vipLevel: 0,
      vipExpiresAt: null,
    });

    expect(policy.level).toBe(0);
    expect(policy.tier.key).toBe('regular');
  });

  it('takes deduplicated global user locks in code-unit order', async () => {
    const executeRaw = jest.fn().mockResolvedValue(2);
    const tx = {
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient;

    await service.lockUsers(tx, ['user-z', 'user-a', 'user-z', 'user-b']);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const query = executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.values).toEqual([
      'membership-user:user-a',
      'membership-user:user-b',
      'membership-user:user-z',
    ]);
    expect(query.sql).toContain('pg_advisory_xact_lock');
    expect(query.sql).toContain('hashtextextended');
  });

  it('does not issue invalid SQL for an empty user batch', async () => {
    const executeRaw = jest.fn();
    const tx = {
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient;

    await service.lockUsers(tx, []);

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('provides a reusable structured quota exception at the limit', () => {
    expect(() =>
      service.assertQuotaAvailable(MembershipQuota.Notes, 50, 50),
    ).toThrow(ForbiddenException);

    try {
      service.assertQuotaAvailable(MembershipQuota.Notes, 50, 50);
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toEqual({
        message: 'Membership notes quota reached',
        errorCode: 'MEMBERSHIP_QUOTA_REACHED',
        quota: 'notes',
        limit: 50,
      });
    }
    expect(() =>
      service.assertQuotaAvailable(MembershipQuota.Notes, 49, 50),
    ).not.toThrow();
  });
});
