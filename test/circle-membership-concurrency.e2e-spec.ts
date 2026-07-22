import { randomUUID } from 'crypto';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { CircleService } from 'src/circle/circle.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { GroupService } from 'src/group/group.service';
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

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    admissionPolicy = app.get(CircleAdmissionPolicy);
    circleService = app.get(CircleService);
    groupService = app.get(GroupService);
    invitationService = app.get(CircleInvitationService);
    memberLock = app.get(CircleMemberLockService);
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
    const joinedCircleIDs = Array.from({ length: 99 }, () => randomUUID());
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
    await expect(
      prisma.circleMember.count({
        where: {
          userID: candidate.id,
          role: { not: CircleMemberRole.OWNER },
          status: CircleMemberStatus.ACTIVE,
        },
      }),
    ).resolves.toBe(100);
    await Promise.all(targetCircleIDs.map(expectCounterConsistent));
  });

  it('serializes a complete batch behind a target leave and re-evaluates the target', async () => {
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
    releaseLeave();
    await Promise.all([leaving, inviting]);

    const finalMembership = await prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: candidate.id, circleID: circle.id },
      },
      select: { status: true },
    });
    expect([null, { status: CircleMemberStatus.ACTIVE }]).toContainEqual(
      finalMembership,
    );
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
    releaseDemotion();
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

  it('keeps one open outbox job for duplicate admission sync writes', async () => {
    const groupID = randomUUID();
    const userID = randomUUID();
    const data = [{ operation: 'ADD_MEMBER' as const, groupID, userID }];

    await Promise.all([
      prisma.groupSyncOutbox.createMany({ data, skipDuplicates: true }),
      prisma.groupSyncOutbox.createMany({ data, skipDuplicates: true }),
    ]);

    await expect(
      prisma.groupSyncOutbox.count({
        where: {
          operation: 'ADD_MEMBER',
          groupID,
          userID,
          status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        },
      }),
    ).resolves.toBe(1);
  });
});
