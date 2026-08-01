import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import { CircleAdmissionPolicy } from './circle-admission-policy';
import { CircleMemberLockService } from './circle-member-lock';

describe('CircleAdmissionPolicy', () => {
  let programEnabled = true;
  const membershipProgram = {
    getStatus: jest.fn(() => Promise.resolve({ enabled: programEnabled })),
  };
  const activeMemberships: Array<{
    id: string;
    userID: string;
    status: 'ACTIVE';
  }> = [];
  const prisma = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'circle-1' }]),
    circle: { findFirst: jest.fn(), findUnique: jest.fn() },
    circleMember: {
      count: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
    },
    circleInvitation: { updateMany: jest.fn() },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  const membershipPolicy = new MembershipPolicyService(
    prisma as unknown as PrismaService,
    membershipProgram as unknown as MembershipProgramService,
  );
  const memberLock = new CircleMemberLockService(membershipPolicy);
  const policy = new CircleAdmissionPolicy(membershipPolicy, memberLock);

  const circle = (overrides: Record<string, unknown> = {}) => ({
    id: 'circle-1',
    deleted: false,
    ownerID: 'owner-1',
    maxMembers: 3000,
    expansionSeats: 0,
    memberCount: 1,
    joinVipRestriction: null,
    joinCreditRestriction: null,
    joinFancyRestriction: false,
    ...overrides,
  });

  const user = (overrides: Record<string, unknown> = {}) => ({
    id: 'candidate-1',
    vipLevel: 0,
    vipExpiresAt: null,
    creditScore: 100,
    fancyNumber: true,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    programEnabled = true;
    prisma.$queryRaw.mockResolvedValue([{ id: 'circle-1' }]);
    prisma.circle.findUnique.mockResolvedValue(circle());
    prisma.circle.findFirst.mockResolvedValue(circle());
    prisma.circleMember.findMany.mockResolvedValue(activeMemberships);
    prisma.circleMember.count.mockResolvedValue(0);
    prisma.circleMember.groupBy.mockResolvedValue([]);
    prisma.circleMember.updateMany.mockResolvedValue({ count: 0 });
    prisma.circleMember.createMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockResolvedValue([user()]);
    prisma.user.findUnique.mockResolvedValue(user());
  });

  it('keeps the joined-circle hard limit at 100 while membership rollout is disabled', async () => {
    programEnabled = false;
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 100 } },
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
        limit: 100,
      },
    });
  });

  it.each([
    [0, null, 100],
    [1, new Date('2026-08-21T00:00:00.000Z'), 100],
    [2, new Date('2026-08-21T00:00:00.000Z'), 100],
    [3, new Date('2026-08-21T00:00:00.000Z'), 100],
    [4, null, 100],
  ])(
    'allows effective level %i at limit - 1 and exposes its joined-circle limit',
    async (vipLevel, vipExpiresAt, limit) => {
      prisma.user.findMany.mockResolvedValue([
        user({ vipLevel, vipExpiresAt }),
      ]);
      prisma.circleMember.groupBy.mockResolvedValue([
        { userID: 'candidate-1', _count: { _all: limit - 1 } },
      ]);

      await expect(
        policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
      ).resolves.toEqual(['candidate-1']);

      // Only ACTIVE non-owner memberships consume the joined-circle limit.
      expect(prisma.circleMember.groupBy).toHaveBeenCalledWith({
        by: ['userID'],
        where: {
          userID: { in: ['candidate-1'] },
          role: { not: 'OWNER' },
          status: 'ACTIVE',
        },
        _count: { _all: true },
      });
    },
  );

  it.each([
    [0, null, 100],
    [1, new Date('2026-08-21T00:00:00.000Z'), 100],
    [2, new Date('2026-08-21T00:00:00.000Z'), 100],
    [3, new Date('2026-08-21T00:00:00.000Z'), 100],
    [4, null, 100],
  ])(
    'denies effective level %i at its joined-circle limit',
    async (vipLevel, vipExpiresAt, limit) => {
      prisma.user.findMany.mockResolvedValue([
        user({ vipLevel, vipExpiresAt }),
      ]);
      prisma.circleMember.groupBy.mockResolvedValue([
        { userID: 'candidate-1', _count: { _all: limit } },
      ]);

      await expect(
        policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
      ).rejects.toMatchObject({
        response: {
          errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
          quota: 'joined-circles',
          limit,
          details: { quota: 'joined-circles', limit },
        },
      });
      expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('falls back to the regular limit when a paid membership expired', async () => {
    prisma.user.findMany.mockResolvedValue([
      user({
        vipLevel: 3,
        vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ]);
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 100 } },
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({ response: { limit: 100 } });
  });

  it('keeps an existing ACTIVE membership idempotent even when over quota', async () => {
    prisma.circleMember.findMany.mockResolvedValue([
      { id: 'member-1', userID: 'candidate-1', status: 'ACTIVE' },
    ]);
    prisma.circleMember.count.mockResolvedValue(5001);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).resolves.toEqual([]);

    expect(prisma.circleMember.count).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
    expect(prisma.circleInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        applicantID: { in: ['candidate-1'] },
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
  });

  it('does not count circles owned by the user toward the joined-circle limit', async () => {
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 99 } },
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).resolves.toEqual(['candidate-1']);

    expect(prisma.circleMember.groupBy).toHaveBeenCalledWith({
      by: ['userID'],
      where: {
        userID: { in: ['candidate-1'] },
        role: { not: 'OWNER' },
        status: 'ACTIVE',
      },
      _count: { _all: true },
    });
  });

  it('blocks a historical over-limit user from another activation', async () => {
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 101 } },
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
        limit: 100,
      },
    });
    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
  });

  it('uses effective membership for the final VIP restriction check', async () => {
    prisma.circle.findUnique.mockResolvedValue(
      circle({ joinVipRestriction: 3 }),
    );
    prisma.user.findMany.mockResolvedValue([
      user({
        vipLevel: 3,
        vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_JOIN_VIP_REQUIRED' },
    });
  });

  it('uses the same effective restriction checks for a pending application', async () => {
    prisma.circle.findFirst.mockResolvedValue(
      circle({ joinVipRestriction: 2 }),
    );
    prisma.user.findUnique.mockResolvedValue(
      user({
        vipLevel: 2,
        vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    );

    await expect(
      policy.assertCanApply(prisma as any, 'circle-1', 'candidate-1'),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_JOIN_VIP_REQUIRED' },
    });
    expect(prisma.circleMember.count).toHaveBeenCalledWith({
      where: {
        userID: 'candidate-1',
        role: { not: 'OWNER' },
        status: 'ACTIVE',
      },
    });
  });

  it('rejects a new application immediately when the user is already at the hard limit', async () => {
    prisma.circleMember.count.mockResolvedValue(100);

    await expect(
      policy.assertCanApply(prisma as any, 'circle-1', 'candidate-1'),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
        limit: 100,
      },
    });
    expect(prisma.circleMember.count).toHaveBeenCalledWith({
      where: {
        userID: 'candidate-1',
        role: { not: 'OWNER' },
        status: 'ACTIVE',
      },
    });
  });

  // 用 toHaveProperty(key, value)（深相等）而不是 toMatchObject（递归部分匹配）：
  // 这条契约的全部意义就是「不多带任何字段」，放过多余字段等于没测。
  const TARGET_LIMIT_RESPONSE = {
    message: 'Target user has reached the joined circle limit',
    errorCode: 'CIRCLE_TARGET_JOIN_LIMIT_REACHED',
  };

  it('hides the invitee join limit from the inviter', async () => {
    prisma.circleMember.count.mockResolvedValue(100);

    // 邀请路径下这个错误回给邀请人，不能泄露被邀请人的额度状态。
    // 也不是 INVITATION_NOT_ALLOWED：那个码既有语义是「对方隐私设置不接受
    // 邀请」，拿来表达配额会让邀请人读到一句与事实不符的提示。
    await expect(
      policy.assertCanApply(prisma as any, 'circle-1', 'candidate-1', {
        actor: 'third-party',
      }),
    ).rejects.toHaveProperty('response', TARGET_LIMIT_RESPONSE);
  });

  it('hides the applicant join limit from an approver', async () => {
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 100 } },
    ]);

    // 审批路径：受限的是申请人，错误却回给圈主 / 担保成员。
    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1'], {
        actor: 'third-party',
      }),
    ).rejects.toHaveProperty('response', TARGET_LIMIT_RESPONSE);

    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
  });

  it('keeps the detailed join limit error when the applicant acts for themselves', async () => {
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 100 } },
    ]);

    // 默认视角不变：本人自助路径仍然拿到可执行的数值。
    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
        limit: 100,
        details: { quota: 'joined-circles', limit: 100 },
      },
    });
  });

  it('prioritizes the user join limit when both the user and circle are full', async () => {
    prisma.circle.findFirst.mockResolvedValue(
      circle({ maxMembers: 10, memberCount: 10 }),
    );
    prisma.circleMember.count.mockResolvedValue(100);

    await expect(
      policy.assertCanApply(prisma as any, 'circle-1', 'candidate-1'),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
        limit: 100,
      },
    });
    expect(prisma.circleMember.count).toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    [
      { joinCreditRestriction: 80 },
      { creditScore: 79 },
      'CIRCLE_JOIN_CREDIT_REQUIRED',
    ],
    [
      { joinFancyRestriction: true },
      { fancyNumber: null },
      'CIRCLE_JOIN_FANCY_NUMBER_REQUIRED',
    ],
  ])(
    'rechecks final circle restrictions before writing',
    async (circleOverrides, userOverrides, errorCode) => {
      prisma.circle.findUnique.mockResolvedValue(circle(circleOverrides));
      prisma.user.findMany.mockResolvedValue([user(userOverrides)]);

      await expect(
        policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
      ).rejects.toMatchObject({ response: { errorCode } });
      expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
    },
  );

  it('does not satisfy a fancy-number restriction with an expired paid lease snapshot', async () => {
    prisma.circle.findUnique.mockResolvedValue(
      circle({ joinFancyRestriction: true }),
    );
    prisma.user.findMany.mockResolvedValue([
      user({
        fancyNumber: true,
        fancyNumberPermanent: false,
        fancyNumberExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_JOIN_FANCY_NUMBER_REQUIRED' },
    });
  });

  it('deduplicates batch IDs and leaves every row untouched when one candidate fails', async () => {
    prisma.user.findMany.mockResolvedValue([
      user({ id: 'candidate-1' }),
      user({ id: 'candidate-2' }),
    ]);
    prisma.circleMember.groupBy.mockResolvedValue([
      { userID: 'candidate-1', _count: { _all: 99 } },
      { userID: 'candidate-2', _count: { _all: 100 } },
    ]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', [
        'candidate-2',
        'candidate-1',
        'candidate-2',
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.circleMember.findMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        userID: { in: ['candidate-1', 'candidate-2'] },
      },
      select: { id: true, userID: true, status: true },
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
  });

  it('takes circle-independent user locks before sorted pair locks and quota counts', async () => {
    prisma.user.findMany.mockResolvedValue([
      user({ id: 'candidate-a' }),
      user({ id: 'candidate-z' }),
    ]);

    await policy.activateMembers(prisma as any, 'circle-1', [
      'candidate-z',
      'candidate-a',
    ]);

    const userLock = prisma.$executeRaw.mock.calls[0][0];
    const pairLock = prisma.$executeRaw.mock.calls[1][0];
    expect(userLock.values).toEqual([
      'membership-user:candidate-a',
      'membership-user:candidate-z',
    ]);
    expect(pairLock.values).toEqual([
      'circle-member:circle-1:candidate-a',
      'circle-member:circle-1:candidate-z',
    ]);
    expect(prisma.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.circleMember.groupBy.mock.invocationCallOrder[0],
    );
    expect(
      prisma.circleMember.groupBy.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
  });

  it('counts joined circles for a 100-user batch with one grouped query', async () => {
    const candidates = Array.from({ length: 100 }, (_, index) =>
      user({ id: `candidate-${String(index).padStart(3, '0')}` }),
    );
    prisma.user.findMany.mockResolvedValue(candidates);

    await expect(
      policy.activateMembers(
        prisma as any,
        'circle-1',
        candidates.map((candidate) => candidate.id),
      ),
    ).resolves.toHaveLength(100);

    expect(prisma.circleMember.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.circleMember.count).not.toHaveBeenCalled();
    expect(prisma.circleMember.createMany).toHaveBeenCalledTimes(1);
  });

  it('reports the owner capacity, not the larger stored maxMembers, when a downgraded owner rejects admission', async () => {
    // reserveCircleSeats fails → capacity rejection. The owner is regular
    // (level 0, groupMembers cap 100) while the circle stores maxMembers 3000,
    // so the bound that actually rejected is 100 — surfacing the stale 3000
    // would mislead clients about why the write failed (#5).
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_MEMBER_LIMIT', limit: 100 },
    });
  });

  it('reports the owner capacity, not null, when a legacy null-cap circle rejects admission', async () => {
    // Legacy circle with maxMembers = null must never surface `limit: null`;
    // the owner's groupMembers cap (regular = 100) is the effective bound.
    prisma.circle.findUnique.mockResolvedValue(circle({ maxMembers: null }));
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_MEMBER_LIMIT', limit: 100 },
    });
  });

  it('adds the permanent group expansion seats to the owner membership capacity', async () => {
    prisma.circle.findUnique.mockResolvedValue(
      circle({ maxMembers: 700, expansionSeats: 600 }),
    );

    await policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']);

    const reserveValues = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(reserveValues[reserveValues.length - 1]).toBe(700);
  });

  it.each([[null], [{ ...circle(), deleted: true }]])(
    'does not activate into a missing or deleted circle',
    async (circleRecord) => {
      prisma.circle.findUnique.mockResolvedValue(circleRecord);

      await expect(
        policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('does not activate a missing candidate', async () => {
    prisma.user.findMany.mockResolvedValue([]);

    await expect(
      policy.activateMembers(prisma as any, 'circle-1', ['candidate-1']),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_USER_NOT_FOUND' },
    });
  });

  it.each([
    [0, 2, null],
    [null, 2, null],
    [2, 2, 2],
  ])(
    'normalizes restriction %p within creator level %i to %p',
    (requested, creatorLevel, expected) => {
      expect(
        policy.normalizeCreatorVipRestriction(requested, creatorLevel as any),
      ).toBe(expected);
    },
  );

  it('rejects a creator restriction above the effective creator membership', () => {
    expect(() => policy.normalizeCreatorVipRestriction(3, 2)).toThrow(
      ForbiddenException,
    );
  });
});
