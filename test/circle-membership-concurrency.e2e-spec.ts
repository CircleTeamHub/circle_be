import { randomUUID } from 'crypto';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { CircleService } from 'src/circle/circle.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { GroupService } from 'src/group/group.service';
import { GroupSyncOutboxProcessor } from 'src/group/group-sync-outbox.processor';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import { CircleMemberRole, CircleMemberStatus } from 'src/generated/prisma';
import { OpenimService } from 'src/openim/openim.service';
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
  let outboxProcessor: GroupSyncOutboxProcessor;
  let openimService: OpenimService;
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

  // Turns on the staged rollout so effective entitlements drop to the stored
  // level (no marketing floor) — required for regular-tier quotas to bite.
  const enableMembershipProgram = () =>
    prisma.membershipProgramState.upsert({
      where: { id: 1 },
      update: { enabledAt: new Date() },
      create: { id: 1, enabledAt: new Date() },
    });

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
    outboxProcessor = app.get(GroupSyncOutboxProcessor);
    openimService = app.get(OpenimService);
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
    // Enable the rollout so the regular joined-circles limit (100) is enforced;
    // while disabled the marketing floor (gold, 300) applies and 99 memberships
    // would be nowhere near the boundary, so no admission would be rejected.
    await enableMembershipProgram();

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

  it('settles a failed ADD before REMOVE and never re-adds after processor restart', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    await groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });
    await prisma.groupSyncOutbox.updateMany({
      where: {
        groupID: circle.id,
        userID: candidate.id,
        operation: 'ADD_MEMBER',
      },
      data: { status: 'FAILED' },
    });

    await groupService.removeGroupMember(admin!.id, circle.id, candidate.id);

    await expect(
      prisma.groupSyncOutbox.findMany({
        where: {
          groupID: circle.id,
          userID: candidate.id,
          status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        },
        select: { operation: true },
      }),
    ).resolves.toEqual([{ operation: 'REMOVE_MEMBER' }]);

    const addSpy = jest
      .spyOn(openimService, 'addGroupMembers')
      .mockResolvedValue(undefined);
    const removeSpy = jest
      .spyOn(openimService, 'removeGroupMember')
      .mockResolvedValue(undefined);
    await outboxProcessor.processPending();
    await outboxProcessor.processPending();

    expect(addSpy).not.toHaveBeenCalledWith(circle.id, [candidate.id]);
    expect(
      removeSpy.mock.calls.filter(
        ([groupID, userID]) => groupID === circle.id && userID === candidate.id,
      ),
    ).toHaveLength(1);
    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
      }),
    ).resolves.toBeNull();
  });

  it('supersedes REMOVE with a later reactivation and applies only ADD', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    await groupService.removeGroupMember(admin!.id, circle.id, candidate.id);
    await groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });

    await expect(
      prisma.groupSyncOutbox.findMany({
        where: {
          groupID: circle.id,
          userID: candidate.id,
          status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        },
        select: { operation: true },
      }),
    ).resolves.toEqual([{ operation: 'ADD_MEMBER' }]);

    const addSpy = jest
      .spyOn(openimService, 'addGroupMembers')
      .mockResolvedValue(undefined);
    const removeSpy = jest
      .spyOn(openimService, 'removeGroupMember')
      .mockResolvedValue(undefined);
    await outboxProcessor.processPending();

    expect(
      addSpy.mock.calls.filter(
        ([groupID, userIDs]) =>
          groupID === circle.id && userIDs.includes(candidate.id),
      ),
    ).toHaveLength(1);
    expect(removeSpy).not.toHaveBeenCalledWith(circle.id, candidate.id);
    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: CircleMemberStatus.ACTIVE });
  });

  it('reconciles REMOVE after a blocked stale ADD resolves last', async () => {
    await prisma.groupSyncOutbox.deleteMany({});
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    await groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });

    let releaseAdd!: () => void;
    const addMayFinish = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    let markAddStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => {
      markAddStarted = resolve;
    });
    let openimHasMember = false;
    jest
      .spyOn(openimService, 'addGroupMembers')
      .mockImplementation(async (groupID, userIDs) => {
        if (groupID === circle.id && userIDs.includes(candidate.id)) {
          markAddStarted();
          await addMayFinish;
          openimHasMember = true;
        }
      });
    const removeSpy = jest
      .spyOn(openimService, 'removeGroupMember')
      .mockImplementation(async (groupID, userID) => {
        if (groupID === circle.id && userID === candidate.id) {
          openimHasMember = false;
        }
      });

    const staleAdd = outboxProcessor.processPending();
    await addStarted;
    const removing = groupService.removeGroupMember(
      admin!.id,
      circle.id,
      candidate.id,
    );
    const removedWithoutNetwork = await Promise.race([
      removing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!removedWithoutNetwork) releaseAdd();
    expect(removedWithoutNetwork).toBe(true);

    await outboxProcessor.processPending();
    releaseAdd();
    await staleAdd;
    expect(openimHasMember).toBe(true);

    await outboxProcessor.processPending();

    expect(openimHasMember).toBe(false);
    expect(
      removeSpy.mock.calls.filter(
        ([groupID, userID]) => groupID === circle.id && userID === candidate.id,
      ),
    ).toHaveLength(1);
    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
      }),
    ).resolves.toBeNull();
  });

  it('reconciles ADD after a blocked stale REMOVE resolves last', async () => {
    await prisma.groupSyncOutbox.deleteMany({});
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    await groupService.removeGroupMember(admin!.id, circle.id, candidate.id);

    let releaseRemove!: () => void;
    const removeMayFinish = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    let markRemoveStarted!: () => void;
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve;
    });
    let openimHasMember = true;
    jest
      .spyOn(openimService, 'removeGroupMember')
      .mockImplementation(async (groupID, userID) => {
        if (groupID === circle.id && userID === candidate.id) {
          markRemoveStarted();
          await removeMayFinish;
          openimHasMember = false;
        }
      });
    const addSpy = jest
      .spyOn(openimService, 'addGroupMembers')
      .mockImplementation(async (groupID, userIDs) => {
        if (groupID === circle.id && userIDs.includes(candidate.id)) {
          openimHasMember = true;
        }
      });

    const staleRemove = outboxProcessor.processPending();
    await removeStarted;
    const reactivating = groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });
    const reactivatedWithoutNetwork = await Promise.race([
      reactivating.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!reactivatedWithoutNetwork) releaseRemove();
    expect(reactivatedWithoutNetwork).toBe(true);

    await outboxProcessor.processPending();
    releaseRemove();
    await staleRemove;
    expect(openimHasMember).toBe(false);

    await outboxProcessor.processPending();

    expect(openimHasMember).toBe(true);
    expect(
      addSpy.mock.calls.filter(
        ([groupID, userIDs]) =>
          groupID === circle.id && userIDs.includes(candidate.id),
      ),
    ).toHaveLength(1);
    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: CircleMemberStatus.ACTIVE });
  });

  it('replays crashed ADD success before advancing to desired REMOVE', async () => {
    await prisma.groupSyncOutbox.deleteMany({});
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    await groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });

    let openimHasMember = false;
    const addSpy = jest
      .spyOn(openimService, 'addGroupMembers')
      .mockImplementation(async () => {
        openimHasMember = true;
      });
    const removeSpy = jest
      .spyOn(openimService, 'removeGroupMember')
      .mockImplementation(async () => {
        openimHasMember = false;
      });
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionCalls = 0;
    const transactionSpy = jest
      .spyOn(prisma as any, '$transaction')
      .mockImplementation((...args: any[]) => {
        transactionCalls += 1;
        if (transactionCalls === 2) {
          return Promise.reject(new Error('simulated process death'));
        }
        return originalTransaction(...(args as [any, any]));
      });

    await expect(outboxProcessor.processPending()).rejects.toThrow(
      'simulated process death',
    );
    transactionSpy.mockRestore();
    expect(openimHasMember).toBe(true);

    await groupService.removeGroupMember(admin!.id, circle.id, candidate.id);
    const state = await prisma.groupSyncOutbox.findUniqueOrThrow({
      where: {
        groupID_userID: { groupID: circle.id, userID: candidate.id },
      },
    });
    expect(state).toMatchObject({
      operation: 'REMOVE_MEMBER',
      generation: 2,
      processingGeneration: 1,
      processingOperation: 'ADD_MEMBER',
      status: 'PENDING',
    });
    await prisma.groupSyncOutbox.update({
      where: { id: state.id },
      data: { lockedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    await outboxProcessor.processPending();
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(openimHasMember).toBe(true);
    await outboxProcessor.processPending();

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(openimHasMember).toBe(false);
    await expect(
      prisma.groupSyncOutbox.findUniqueOrThrow({
        where: {
          groupID_userID: { groupID: circle.id, userID: candidate.id },
        },
        select: {
          operation: true,
          generation: true,
          processingGeneration: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      operation: 'REMOVE_MEMBER',
      generation: 2,
      processingGeneration: null,
      status: 'COMPLETED',
    });
  });

  it('replays crashed REMOVE success before advancing to desired ADD', async () => {
    await prisma.groupSyncOutbox.deleteMany({});
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });
    await prisma.circle.update({
      where: { id: circle.id },
      data: { groupID: circle.id },
    });
    await groupService.removeGroupMember(admin!.id, circle.id, candidate.id);

    let openimHasMember = true;
    const removeSpy = jest
      .spyOn(openimService, 'removeGroupMember')
      .mockImplementation(async () => {
        openimHasMember = false;
      });
    const addSpy = jest
      .spyOn(openimService, 'addGroupMembers')
      .mockImplementation(async () => {
        openimHasMember = true;
      });
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionCalls = 0;
    const transactionSpy = jest
      .spyOn(prisma as any, '$transaction')
      .mockImplementation((...args: any[]) => {
        transactionCalls += 1;
        if (transactionCalls === 2) {
          return Promise.reject(new Error('simulated process death'));
        }
        return originalTransaction(...(args as [any, any]));
      });

    await expect(outboxProcessor.processPending()).rejects.toThrow(
      'simulated process death',
    );
    transactionSpy.mockRestore();
    expect(openimHasMember).toBe(false);

    await groupService.inviteGroupMembers(admin!.id, circle.id, {
      userIDs: [candidate.id],
    });
    const state = await prisma.groupSyncOutbox.findUniqueOrThrow({
      where: {
        groupID_userID: { groupID: circle.id, userID: candidate.id },
      },
    });
    expect(state).toMatchObject({
      operation: 'ADD_MEMBER',
      generation: 2,
      processingGeneration: 1,
      processingOperation: 'REMOVE_MEMBER',
      status: 'PENDING',
    });
    await prisma.groupSyncOutbox.update({
      where: { id: state.id },
      data: { lockedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    await outboxProcessor.processPending();
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(openimHasMember).toBe(false);
    await outboxProcessor.processPending();

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(openimHasMember).toBe(true);
    await expect(
      prisma.circleMember.findUnique({
        where: {
          userID_circleID: { userID: candidate.id, circleID: circle.id },
        },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: CircleMemberStatus.ACTIVE });
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
