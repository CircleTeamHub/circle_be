import { randomUUID } from 'crypto';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleErrorCode } from 'src/common/app-error-codes';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { CircleService } from 'src/circle/circle.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { GroupService } from 'src/group/group.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import { CircleMemberRole, CircleMemberStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import { getE2eApp } from './e2e-context';

function canRunPostgresE2e(): boolean {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !databaseUrl || !process.env.SECRET) {
    return false;
  }

  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      /(^|[_-])test($|[_-])/i.test(databaseName)
    );
  } catch {
    return false;
  }
}

const describePostgres = canRunPostgresE2e() ? describe : describe.skip;

describePostgres('Circle membership transition concurrency e2e', () => {
  let prisma: PrismaService;
  let admissionPolicy: CircleAdmissionPolicy;
  let circleService: CircleService;
  let groupService: GroupService;
  let invitationService: CircleInvitationService;
  let memberLock: CircleMemberLockService;
  let membershipPolicy: MembershipPolicyService;
  let programService: MembershipProgramService;

  const createUser = async (label: string) => {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `${label}-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `${label} ${suffix}`,
      },
    });
  };

  const createCircleWithPendingMember = async (options?: {
    admin?: boolean;
  }) => {
    const [owner, candidate] = await Promise.all([
      createUser('owner'),
      createUser('candidate'),
    ]);
    const admin = options?.admin ? await createUser('admin') : null;
    const circle = await prisma.circle.create({
      data: {
        id: randomUUID(),
        name: 'Membership race',
        ownerID: owner.id,
        memberCount: admin ? 2 : 1,
        maxMembers: 100,
      },
    });
    await prisma.circleMember.createMany({
      data: [
        {
          circleID: circle.id,
          userID: owner.id,
          role: CircleMemberRole.OWNER,
          status: CircleMemberStatus.ACTIVE,
        },
        ...(admin
          ? [
              {
                circleID: circle.id,
                userID: admin.id,
                role: CircleMemberRole.ADMIN,
                status: CircleMemberStatus.ACTIVE,
              },
            ]
          : []),
        {
          circleID: circle.id,
          userID: candidate.id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.PENDING,
        },
      ],
    });
    return { owner, admin, candidate, circle };
  };

  const activate = (circleID: string, userID: string) =>
    runSerializableTransaction(prisma, (tx) =>
      admissionPolicy.activateMembers(tx, circleID, [userID]),
    );

  const expectCounterConsistent = async (circleID: string) => {
    const [circle, activeCount] = await Promise.all([
      prisma.circle.findUniqueOrThrow({
        where: { id: circleID },
        select: { memberCount: true },
      }),
      prisma.circleMember.count({
        where: { circleID, status: CircleMemberStatus.ACTIVE },
      }),
    ]);
    expect(circle.memberCount).toBe(activeCount);
  };

  // 「排在持锁事务后面」要等竞争方真的排进了锁队列才成立。持锁方在发起竞争方的
  // 同一拍就放行的话,竞争方往往还没开事务对方就已提交 —— 测到的只是先后两次
  // 调用,真正被挡住的那条路径只在 CI 偶尔撞上一次。
  const waitUntilAdvisoryLockIsContended = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `;
      if (waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The racing call never queued behind the held lock');
  };

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    admissionPolicy = app.get(CircleAdmissionPolicy);
    circleService = app.get(CircleService);
    groupService = app.get(GroupService);
    invitationService = app.get(CircleInvitationService);
    memberLock = app.get(CircleMemberLockService);
    membershipPolicy = app.get(MembershipPolicyService);
    programService = app.get(MembershipProgramService);
  });

  it('keeps count consistent when pending activation races circle leave', async () => {
    const { candidate, circle } = await createCircleWithPendingMember();

    await Promise.allSettled([
      activate(circle.id, candidate.id),
      circleService.leaveCircle(candidate.id, circle.id),
    ]);

    await expectCounterConsistent(circle.id);
  });

  it('keeps count consistent when pending activation races group leave', async () => {
    const { candidate, circle } = await createCircleWithPendingMember();

    await Promise.allSettled([
      activate(circle.id, candidate.id),
      groupService.leaveGroup(candidate.id, circle.id),
    ]);

    await expectCounterConsistent(circle.id);
  });

  it('keeps count consistent when pending activation races admin removal', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });

    await Promise.allSettled([
      activate(circle.id, candidate.id),
      groupService.removeGroupMember(admin!.id, circle.id, candidate.id),
    ]);

    await expectCounterConsistent(circle.id);
  });

  it('allows exactly one same-user admission from joined quota minus one', async () => {
    const [owner, candidate] = await Promise.all([
      createUser('quota-owner'),
      createUser('quota-candidate'),
    ]);
    await prisma.user.update({
      where: { id: candidate.id },
      data: {
        vipLevel: 2,
        vipExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const joinedCircleIDs = Array.from({ length: 299 }, () => randomUUID());
    const targetCircleIDs = [randomUUID(), randomUUID()];
    await prisma.circle.createMany({
      data: [...joinedCircleIDs, ...targetCircleIDs].map((id, index) => ({
        id,
        name: `Quota circle ${index}`,
        ownerID: owner.id,
        memberCount: joinedCircleIDs.includes(id) ? 2 : 1,
        maxMembers: 100,
      })),
    });
    await prisma.circleMember.createMany({
      data: [
        ...[...joinedCircleIDs, ...targetCircleIDs].map((circleID) => ({
          circleID,
          userID: owner.id,
          role: CircleMemberRole.OWNER,
          status: CircleMemberStatus.ACTIVE,
        })),
        ...joinedCircleIDs.map((circleID) => ({
          circleID,
          userID: candidate.id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.ACTIVE,
        })),
        ...targetCircleIDs.map((circleID) => ({
          circleID,
          userID: candidate.id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.PENDING,
        })),
      ],
    });
    const results = await Promise.allSettled(
      targetCircleIDs.map((circleID) => activate(circleID, candidate.id)),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_LIMIT_REACHED',
        limit: 300,
      },
    });
    await expect(
      prisma.circleMember.count({
        where: {
          userID: candidate.id,
          role: { not: CircleMemberRole.OWNER },
          status: CircleMemberStatus.ACTIVE,
        },
      }),
    ).resolves.toBe(300);
    await Promise.all(targetCircleIDs.map(expectCounterConsistent));
  });

  it('serializes a complete batch behind a target leave without half-applying it', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await activate(circle.id, candidate.id);

    let releaseLeave!: () => void;
    const leaveMayCommit = new Promise<void>((resolve) => {
      releaseLeave = resolve;
    });
    let leaveLocked!: () => void;
    const leaveHasLock = new Promise<void>((resolve) => {
      leaveLocked = resolve;
    });
    const leaving = runSerializableTransaction(prisma, async (tx) => {
      await memberLock.lock(tx, circle.id, [candidate.id]);
      leaveLocked();
      await leaveMayCommit;
      await tx.circleMember.delete({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
      });
      await tx.circle.update({
        where: { id: circle.id },
        data: { memberCount: { decrement: 1 } },
      });
    });
    await leaveHasLock;

    const inviting = groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id, candidate.id],
    });
    try {
      await waitUntilAdvisoryLockIsContended();
    } finally {
      releaseLeave();
    }
    const [leaveResult, inviteResult] = await Promise.allSettled([
      leaving,
      inviting,
    ]);

    expect(leaveResult.status).toBe('fulfilled');
    const [finalMembership, invitationCount] = await Promise.all([
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
        select: { status: true },
      }),
      prisma.circleInvitation.count({
        where: { circleID: circle.id, applicantID: candidate.id },
      }),
    ]);
    // Serializable 的快照在事务第一条语句(拿成员锁、还在排队时)就定了,锁后复核
    // 看不到退圈的提交:整批按「排在退圈之前」执行,目标仍是成员,整批回滚。这是合法
    // 的串行顺序。要守住的是整批不落半截、计数不漂。
    if (inviteResult.status === 'fulfilled') {
      expect(finalMembership).toEqual({ status: CircleMemberStatus.ACTIVE });
    } else {
      expect(inviteResult.reason).toMatchObject({
        response: { errorCode: CircleErrorCode.AlreadyMember },
      });
      expect(finalMembership).toBeNull();
      expect(invitationCount).toBe(0);
    }
    await expectCounterConsistent(circle.id);
  });

  it('blocks admin approval behind a locked demotion and then rejects it', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    const invitation = await prisma.circleInvitation.create({
      data: {
        circleID: circle.id,
        applicantID: candidate.id,
        inviterID: admin!.id,
      },
    });

    let releaseDemotion!: () => void;
    const demotionMayCommit = new Promise<void>((resolve) => {
      releaseDemotion = resolve;
    });
    let demotionLocked!: () => void;
    const demotionHasLock = new Promise<void>((resolve) => {
      demotionLocked = resolve;
    });
    const demoting = runSerializableTransaction(prisma, async (tx) => {
      await memberLock.lock(tx, circle.id, [admin!.id, candidate.id]);
      demotionLocked();
      await demotionMayCommit;
      await tx.circleMember.update({
        where: {
          userID_circleID: { userID: admin!.id, circleID: circle.id },
        },
        data: { role: CircleMemberRole.MEMBER },
      });
    });
    await demotionHasLock;

    const approving = invitationService.adminApprove(admin!.id, invitation.id);
    try {
      await waitUntilAdvisoryLockIsContended();
    } finally {
      releaseDemotion();
    }
    const [demotionResult, approvalResult] = await Promise.allSettled([
      demoting,
      approving,
    ]);

    expect(demotionResult.status).toBe('fulfilled');
    expect(approvalResult.status).toBe('rejected');
    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: CircleMemberStatus.PENDING });
  });

  it('serializes a batch invite with the inviter leaving the circle', async () => {
    const { admin, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    const target = await createUser('actor-leave-target');

    const [leaveResult, inviteResult] = await Promise.allSettled([
      groupService.leaveGroup(admin!.id, circle.id),
      groupService.inviteGroupMembers(admin!.id, circle.id, {
        userIDs: [target.id],
      }),
    ]);

    expect(leaveResult.status).toBe('fulfilled');
    const targetMembership = await prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: target.id, circleID: circle.id },
      },
      select: { status: true },
    });
    if (inviteResult.status === 'fulfilled') {
      expect(targetMembership).toEqual({ status: CircleMemberStatus.ACTIVE });
    } else {
      expect(targetMembership).toBeNull();
    }
    await expectCounterConsistent(circle.id);
  });

  it('does not re-admit a removed member through a cancelled invitation', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    const invitation = await prisma.circleInvitation.create({
      data: {
        circleID: circle.id,
        applicantID: candidate.id,
        inviterID: admin!.id,
      },
    });

    await groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });
    await groupService.removeGroupMember(admin!.id, circle.id, candidate.id);
    await expect(
      invitationService.adminApprove(admin!.id, invitation.id),
    ).rejects.toBeDefined();

    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
      }),
    ).resolves.toBeNull();
    await expectCounterConsistent(circle.id);
  });

  it('serializes rollout enablement against an in-flight entitlement-write read', async () => {
    const operator = await createUser('rollout-operator');

    let releaseHold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let signalAcquired: () => void = () => undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });

    // A quota-writing transaction takes the SHARED program lock (as every
    // entitlement write now does via lockForWrite) and holds it open.
    const holdTx = runSerializableTransaction(prisma, async (tx) => {
      await membershipPolicy.loadProgramStatus(tx, { lockForWrite: true });
      signalAcquired();
      await held;
    });

    await lockAcquired;

    // enable() takes the EXCLUSIVE lock on the same key, so it must not commit
    // while the shared lock is held — proving the read+write serialize with it.
    let enableDone = false;
    const enablePromise = programService.enable(operator.id).then((result) => {
      enableDone = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(enableDone).toBe(false);

    releaseHold();
    await holdTx;
    const result = await enablePromise;
    expect(enableDone).toBe(true);
    expect(result.status.enabled).toBe(true);
  });
});
