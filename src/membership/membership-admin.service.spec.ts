import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { MembershipBenefitType } from 'src/generated/prisma';
import { MembershipErrorCode } from 'src/common/app-error-codes';
import { MembershipAdminService } from './membership-admin.service';

describe('MembershipAdminService', () => {
  const now = new Date('2027-07-21T12:00:00.000Z');
  const operatorId = 'operator-1';
  const targetId = 'target-1';
  const idempotencyKey = '30000000-0000-4000-8000-000000000003';

  const tx = {
    membershipGrant: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    membershipBenefitGrant: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<any>) =>
      callback(tx),
    ),
    membershipGrant: { findUnique: jest.fn() },
  };
  const policy = {
    lockUsers: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn(
      (
        membership: { vipLevel: number; vipExpiresAt: Date | null },
        at: Date,
      ) => {
        const timedExpired =
          membership.vipLevel > 0 &&
          membership.vipLevel < 4 &&
          membership.vipExpiresAt !== null &&
          membership.vipExpiresAt.getTime() <= at.getTime();
        const level = timedExpired ? 0 : Math.min(4, membership.vipLevel);
        return { level };
      },
    ),
  };
  const notification = {
    createSystemNotification: jest.fn().mockResolvedValue(null),
  };
  const realtime = {
    invalidateUserHotCache: jest.fn().mockResolvedValue(undefined),
    broadcastMembershipStatus: jest.fn().mockResolvedValue(undefined),
    broadcastUserProfileSummary: jest.fn().mockResolvedValue(undefined),
    broadcastSystemNotificationCreated: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn().mockResolvedValue(undefined),
    safeBroadcastAll: jest
      .fn()
      .mockImplementation((fns: Array<() => void | Promise<void>>) =>
        Promise.allSettled(fns.map((fn) => fn())),
      ),
  };
  let service: MembershipAdminService;

  function user(
    vipLevel: number,
    vipExpiresAt: Date | null,
    benefitTypes: MembershipBenefitType[] = [],
  ) {
    return {
      id: targetId,
      vipLevel,
      vipExpiresAt,
      membershipBenefitGrants: benefitTypes.map((type) => ({ type })),
    };
  }

  function createdGrant(data: Record<string, any>) {
    return {
      id: 'grant-1',
      createdAt: now,
      ...data,
    };
  }

  function existingGrant(overrides: Record<string, any> = {}) {
    return {
      id: 'grant-1',
      idempotencyKey,
      targetUserID: targetId,
      operatorUserID: operatorId,
      previousLevel: 0,
      newLevel: 3,
      previousExpiresAt: null,
      newExpiresAt: new Date('2028-07-21T12:00:00.000Z'),
      note: 'case approved',
      createdAt: now,
      benefitGrants: [{ type: MembershipBenefitType.STANDARD_FANCY_NUMBER }],
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    tx.membershipGrant.findUnique.mockResolvedValue(null);
    tx.membershipGrant.create.mockImplementation(({ data }) =>
      Promise.resolve(createdGrant(data)),
    );
    tx.membershipBenefitGrant.findUnique.mockResolvedValue(null);
    tx.membershipBenefitGrant.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'benefit-1', createdAt: now, ...data }),
    );
    tx.user.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: targetId, ...data }),
    );
    prisma.membershipGrant.findUnique.mockResolvedValue(null);
    notification.createSystemNotification.mockResolvedValue(null);
    realtime.invalidateUserHotCache.mockResolvedValue(undefined);
    realtime.safeBroadcastAll.mockImplementation((fns) =>
      Promise.allSettled(fns.map((fn) => fn())),
    );

    service = new MembershipAdminService(
      prisma as never,
      policy as never,
      notification as never,
      realtime as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('activates a timed tier inside the user lock and writes its audit atomically', async () => {
    tx.user.findUnique.mockResolvedValue(user(0, null));

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 1,
      idempotencyKey,
      note: '  case approved  ',
    });

    const expiresAt = new Date('2027-08-21T12:00:00.000Z');
    expect(policy.lockUsers).toHaveBeenCalledWith(tx, [targetId]);
    expect(policy.lockUsers.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { vipLevel: 1, vipExpiresAt: expiresAt },
    });
    expect(tx.membershipGrant.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey,
        targetUserID: targetId,
        operatorUserID: operatorId,
        previousLevel: 0,
        newLevel: 1,
        previousExpiresAt: null,
        newExpiresAt: expiresAt,
        note: 'case approved',
      },
    });
    expect(result).toMatchObject({
      replayed: false,
      grant: {
        previousLevel: 0,
        previousEffectiveLevel: 0,
        newLevel: 1,
        newExpiresAt: expiresAt,
      },
      membership: { effectiveLevel: 1, key: 'silver' },
      issuedBenefitTypes: [],
    });
  });

  it('preserves remaining time when upgrading between timed tiers', async () => {
    const currentExpiry = new Date('2027-08-31T10:15:00.000Z');
    tx.user.findUnique.mockResolvedValue(user(1, currentExpiry));

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 2,
      idempotencyKey,
    });

    expect(result.grant.newExpiresAt).toEqual(
      new Date('2028-02-29T10:15:00.000Z'),
    );
  });

  it('uses UTC month-end leap arithmetic for a new timed activation', async () => {
    jest.setSystemTime(new Date('2028-01-31T23:30:00.000Z').getTime());
    tx.user.findUnique.mockResolvedValue(user(0, null));

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 1,
      idempotencyKey,
    });

    expect(result.grant.newExpiresAt).toEqual(
      new Date('2028-02-29T23:30:00.000Z'),
    );
  });

  it('makes super lifetime and clears any timed expiry', async () => {
    tx.user.findUnique.mockResolvedValue(
      user(3, new Date('2028-06-01T00:00:00.000Z')),
    );

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 4,
      idempotencyKey,
    });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { vipLevel: 4, vipExpiresAt: null },
    });
    expect(result.membership).toMatchObject({
      effectiveLevel: 4,
      lifetime: true,
      vipExpiresAt: null,
    });
  });

  it('rejects a service-level invalid target with a stable 400 code', async () => {
    await expect(
      service.grant(operatorId, targetId, {
        targetLevel: 5,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { errorCode: MembershipErrorCode.InvalidLevel },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a target that is not higher than the effective level', async () => {
    tx.user.findUnique.mockResolvedValue(user(2, null));

    await expect(
      service.grant(operatorId, targetId, {
        targetLevel: 2,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { errorCode: MembershipErrorCode.LevelNotHigher },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('reactivates an expired user at the same stored level', async () => {
    tx.user.findUnique.mockResolvedValue(
      user(2, new Date('2027-07-20T00:00:00.000Z')),
    );

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 2,
      idempotencyKey,
    });

    expect(result.grant).toMatchObject({
      previousLevel: 2,
      previousEffectiveLevel: 0,
      newLevel: 2,
    });
    expect(result.grant.newExpiresAt).toEqual(
      new Date('2028-01-21T12:00:00.000Z'),
    );
  });

  it('does not reactivate an expired membership below its stored level', async () => {
    tx.user.findUnique.mockResolvedValue(
      user(3, new Date('2027-07-20T00:00:00.000Z')),
    );

    await expect(
      service.grant(operatorId, targetId, {
        targetLevel: 2,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { errorCode: MembershipErrorCode.LevelNotHigher },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('returns a stable not-found error for a nonexistent target', async () => {
    tx.user.findUnique.mockResolvedValue(null);

    await expect(
      service.grant(operatorId, targetId, {
        targetLevel: 1,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { errorCode: MembershipErrorCode.UserNotFound },
    });
  });

  it('replays an exactly matching idempotency key without writes or side effects', async () => {
    tx.membershipGrant.findUnique.mockResolvedValue(existingGrant());

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 3,
      idempotencyKey,
      note: ' case approved ',
    });

    expect(result).toMatchObject({
      replayed: true,
      grant: { id: 'grant-1', newLevel: 3 },
      issuedBenefitTypes: [MembershipBenefitType.STANDARD_FANCY_NUMBER],
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.membershipBenefitGrant.create).not.toHaveBeenCalled();
    expect(notification.createSystemNotification).not.toHaveBeenCalled();
    expect(realtime.invalidateUserHotCache).not.toHaveBeenCalled();
    expect(realtime.safeBroadcastAll).not.toHaveBeenCalled();
  });

  it('returns a stable 409 when an idempotency key payload differs', async () => {
    tx.membershipGrant.findUnique.mockResolvedValue(existingGrant());

    await expect(
      service.grant(operatorId, targetId, {
        targetLevel: 4,
        idempotencyKey,
        note: 'case approved',
      }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { errorCode: MembershipErrorCode.IdempotencyConflict },
    });
  });

  it('converges concurrent duplicates to one grant and one side-effect sequence', async () => {
    let stored: ReturnType<typeof existingGrant> | null = null;
    let queue = Promise.resolve();
    prisma.$transaction.mockImplementation((callback) => {
      const run = queue.then(() => callback(tx));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    });
    tx.membershipGrant.findUnique.mockImplementation(() =>
      Promise.resolve(stored),
    );
    tx.user.findUnique.mockResolvedValue(user(0, null));
    tx.membershipGrant.create.mockImplementation(({ data }) => {
      stored = existingGrant({
        ...data,
        newLevel: 3,
        newExpiresAt: new Date('2028-07-21T12:00:00.000Z'),
        benefitGrants: [{ type: MembershipBenefitType.STANDARD_FANCY_NUMBER }],
      });
      return Promise.resolve(stored);
    });

    const results = await Promise.all([
      service.grant(operatorId, targetId, {
        targetLevel: 3,
        idempotencyKey,
        note: 'case approved',
      }),
      service.grant(operatorId, targetId, {
        targetLevel: 3,
        idempotencyKey,
        note: 'case approved',
      }),
    ]);

    expect(
      results
        .map((result) => result.replayed)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(tx.membershipGrant.create).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.membershipBenefitGrant.create).toHaveBeenCalledTimes(1);
    expect(notification.createSystemNotification).toHaveBeenCalledTimes(1);
    expect(realtime.invalidateUserHotCache).toHaveBeenCalledTimes(1);
    expect(realtime.safeBroadcastAll).toHaveBeenCalledTimes(1);
  });

  it.each([
    [3, MembershipBenefitType.STANDARD_FANCY_NUMBER],
    [4, MembershipBenefitType.PREMIUM_FANCY_NUMBER],
  ])(
    'issues the one-time benefit for level %i only once',
    async (targetLevel, type) => {
      tx.user.findUnique.mockResolvedValue(user(targetLevel - 1, null));

      const result = await service.grant(operatorId, targetId, {
        targetLevel,
        idempotencyKey,
      });

      expect(tx.membershipBenefitGrant.create).toHaveBeenCalledWith({
        data: { userID: targetId, membershipGrantID: 'grant-1', type },
      });
      expect(result.issuedBenefitTypes).toEqual([type]);
      if (targetLevel === 4) {
        expect(result.issuedBenefitTypes).not.toContain(
          MembershipBenefitType.STANDARD_FANCY_NUMBER,
        );
      }
    },
  );

  it('does not duplicate a benefit already issued to the user', async () => {
    tx.user.findUnique.mockResolvedValue(
      user(2, null, [MembershipBenefitType.STANDARD_FANCY_NUMBER]),
    );

    const result = await service.grant(operatorId, targetId, {
      targetLevel: 3,
      idempotencyKey,
    });

    expect(tx.membershipBenefitGrant.create).not.toHaveBeenCalled();
    expect(result.issuedBenefitTypes).toEqual([]);
  });

  it('invalidates cache before broadcasting membership and profile changes', async () => {
    tx.user.findUnique.mockResolvedValue(user(0, null));

    await service.grant(operatorId, targetId, {
      targetLevel: 1,
      idempotencyKey,
    });

    expect(notification.createSystemNotification).toHaveBeenCalledTimes(1);
    expect(realtime.broadcastMembershipStatus).toHaveBeenCalledWith(targetId);
    expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(targetId);
    expect(
      realtime.invalidateUserHotCache.mock.invocationCallOrder[0],
    ).toBeLessThan(realtime.safeBroadcastAll.mock.invocationCallOrder[0]);
  });

  it('returns the committed grant when every post-commit side effect fails', async () => {
    tx.user.findUnique.mockResolvedValue(user(0, null));
    notification.createSystemNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );
    realtime.invalidateUserHotCache.mockRejectedValue(
      new Error('cache unavailable'),
    );
    realtime.safeBroadcastAll.mockRejectedValue(
      new Error('realtime unavailable'),
    );

    await expect(
      service.grant(operatorId, targetId, {
        targetLevel: 1,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ replayed: false, grant: { id: 'grant-1' } });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.membershipGrant.create).toHaveBeenCalledTimes(1);
  });
});
