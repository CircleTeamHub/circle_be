import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CircleMemberRole, CircleMemberStatus } from 'src/generated/prisma';
import { JwtGuard } from 'src/guards/jwt.guard';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';
import * as groupMemberDtos from './dto/group-member.dto';

describe('GroupService reportGroup', () => {
  let prisma: {
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    circle: { findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    circleMember: {
      create: jest.Mock;
      createMany: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    conversationGroupMembership: { deleteMany: jest.Mock };
    groupSyncOutbox: {
      createMany: jest.Mock;
      updateMany: jest.Mock;
    };
    circleInvitation: { updateMany: jest.Mock };
    groupReport: {
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    friend: { findMany: jest.Mock };
    userPrivacySetting: { findMany: jest.Mock };
    userDisplayIcon: { deleteMany: jest.Mock };
  };
  let openim: {
    addGroupMembers: jest.Mock;
    getGroupMemberRole: jest.Mock;
    isGroupMember: jest.Mock;
    removeGroupMember: jest.Mock;
    setGroupMemberRole: jest.Mock;
  };
  let admissionPolicy: {
    activateMembers: jest.Mock;
  };
  let memberLock: { lock: jest.Mock };
  let service: GroupService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (callback) => callback(prisma)),
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'circle-1' }]),
      circle: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      circleMember: {
        create: jest.fn(),
        createMany: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      conversationGroupMembership: { deleteMany: jest.fn() },
      groupSyncOutbox: {
        createMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      circleInvitation: { updateMany: jest.fn() },
      groupReport: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      friend: { findMany: jest.fn().mockResolvedValue([]) },
      userPrivacySetting: { findMany: jest.fn().mockResolvedValue([]) },
      userDisplayIcon: { deleteMany: jest.fn() },
    };
    openim = {
      addGroupMembers: jest.fn().mockResolvedValue(undefined),
      getGroupMemberRole: jest.fn(),
      isGroupMember: jest.fn().mockResolvedValue(false),
      removeGroupMember: jest.fn().mockResolvedValue(undefined),
      setGroupMemberRole: jest.fn().mockResolvedValue(undefined),
    };
    admissionPolicy = {
      activateMembers: jest.fn(async (_tx, _circleID, userIDs) => userIDs),
    };
    memberLock = { lock: jest.fn() };
    service = new GroupService(
      prisma as any,
      openim as any,
      admissionPolicy as any,
      memberLock as any,
    );
  });

  it('creates a group report for an active circle member', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.groupReport.findFirst.mockResolvedValue(null);
    prisma.groupReport.create.mockResolvedValue({ id: 'report-1' });

    await service.reportGroup('user-1', 'group-1', {
      category: 'spam',
      description: ' repeated ads ',
      evidence: ['reports/group-1.png'],
    });

    expect(prisma.circle.findFirst).toHaveBeenCalledWith({
      where: {
        deleted: false,
        OR: [{ id: 'group-1' }, { groupID: 'group-1' }],
      },
      select: { id: true, groupID: true },
    });
    expect(prisma.circleMember.findUnique).toHaveBeenCalledWith({
      where: { userID_circleID: { userID: 'user-1', circleID: 'circle-1' } },
      select: { status: true },
    });
    expect(prisma.groupReport.create).toHaveBeenCalledWith({
      data: {
        reporterID: 'user-1',
        groupID: 'group-1',
        circleID: 'circle-1',
        category: 'spam',
        description: 'repeated ads',
        evidence: ['reports/group-1.png'],
      },
    });
  });

  it('rejects reporting a known circle when the reporter is not an active member', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      status: CircleMemberStatus.PENDING,
    });

    await expect(
      service.reportGroup('user-1', 'group-1', {
        category: 'fraud',
        description: 'fake giveaway',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.groupReport.create).not.toHaveBeenCalled();
  });

  it('creates a raw OpenIM group report when OpenIM verifies membership', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);
    openim.isGroupMember.mockResolvedValue(true);
    prisma.groupReport.findFirst.mockResolvedValue(null);
    prisma.groupReport.create.mockResolvedValue({ id: 'report-1' });

    await service.reportGroup('user-1', 'sg_tmp123', {
      category: 'harassment',
      description: ' bad messages ',
      evidence: ['reports/raw-1.png'],
    });

    expect(openim.isGroupMember).toHaveBeenCalledWith('tmp123', 'user-1');
    expect(prisma.circleMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.groupReport.create).toHaveBeenCalledWith({
      data: {
        reporterID: 'user-1',
        groupID: 'tmp123',
        circleID: null,
        category: 'harassment',
        description: 'bad messages',
        evidence: ['reports/raw-1.png'],
      },
    });
  });

  it('rejects raw OpenIM group reports when OpenIM says the reporter is not a member', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);
    openim.isGroupMember.mockResolvedValue(false);

    await expect(
      service.reportGroup('user-1', 'sg_tmp123', {
        category: 'harassment',
        description: 'bad messages',
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.circleMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.groupReport.create).not.toHaveBeenCalled();
  });

  it('returns service unavailable when raw OpenIM membership cannot be verified', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);
    openim.isGroupMember.mockRejectedValue(new Error('openim down'));

    await expect(
      service.reportGroup('user-1', 'sg_tmp123', {
        category: 'harassment',
        description: 'bad messages',
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.groupReport.findFirst).not.toHaveBeenCalled();
    expect(prisma.groupReport.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate group reports for the same reporter/group/category', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.groupReport.findFirst.mockResolvedValue({ id: 'existing-report' });

    await expect(
      service.reportGroup('user-1', 'group-1', {
        category: 'spam',
        description: 'again',
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.groupReport.create).not.toHaveBeenCalled();
  });

  it('rejects group reports whose description is blank after trimming', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);

    await expect(
      service.reportGroup('user-1', 'sg_tmp123', {
        category: 'spam',
        description: '   ',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.groupReport.findFirst).not.toHaveBeenCalled();
    expect(prisma.groupReport.create).not.toHaveBeenCalled();
  });

  it('passes group report payloads through the controller with the current user', async () => {
    const serviceMock = {
      reportGroup: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new GroupController(serviceMock as any);

    await controller.reportGroup(
      'group-1',
      {
        category: 'impersonation',
        description: 'pretending to be official',
        evidence: ['proof-1'],
      } as any,
      { user: { userId: 'user-1' } } as any,
    );

    expect(serviceMock.reportGroup).toHaveBeenCalledWith('user-1', 'group-1', {
      category: 'impersonation',
      description: 'pretending to be official',
      evidence: ['proof-1'],
    });
  });

  it('requires authentication and throttling for group routes', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, GroupController);
    const invite = GroupController.prototype.inviteGroupMembers;
    const remove = GroupController.prototype.removeGroupMember;
    const report = GroupController.prototype.reportGroup;

    expect(guards).toEqual([ThrottlerGuard, JwtGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', invite)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', remove)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', report)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', report)).toBe(60_000);
  });

  it('cleans custom conversation group memberships for a raw OpenIM group leave', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);
    prisma.conversationGroupMembership.deleteMany.mockResolvedValue({
      count: 2,
    });

    await service.leaveGroup('user-1', 'group-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.conversationGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: {
        conversationID: { in: ['group-1', 'sg_group-1'] },
        group: { ownerID: 'user-1' },
      },
    });
    expect(prisma.circleMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.circleMember.delete).not.toHaveBeenCalled();
  });

  it('removes local circle membership state when leaving a mapped group', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: CircleMemberRole.MEMBER,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.delete.mockResolvedValue({});
    prisma.circle.update.mockResolvedValue({});
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({ count: 1 });
    prisma.conversationGroupMembership.deleteMany.mockResolvedValue({
      count: 1,
    });

    await service.leaveGroup('user-1', 'group-1');

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'user-1',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
    expect(prisma.circleMember.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.userDisplayIcon.deleteMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', circleID: 'circle-1' },
    });
    expect(prisma.circleMember.delete).toHaveBeenCalledWith({
      where: { id: 'member-1' },
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { memberCount: { decrement: 1 } },
    });
    expect(prisma.circleInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        applicantID: 'user-1',
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
    expect(prisma.conversationGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: {
        conversationID: { in: ['group-1', 'sg_group-1'] },
        group: { ownerID: 'user-1' },
      },
    });
  });

  it('locks and re-reads an active membership before leave accounting', async () => {
    let insideTransaction = false;
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      insideTransaction = true;
      return callback(prisma);
    });
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockImplementation(() =>
      Promise.resolve({
        id: 'member-1',
        role: CircleMemberRole.MEMBER,
        status: insideTransaction
          ? CircleMemberStatus.ACTIVE
          : CircleMemberStatus.PENDING,
      }),
    );

    await service.leaveGroup('user-1', 'group-1');

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'user-1',
    ]);
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { memberCount: { decrement: 1 } },
    });
  });

  it('does not allow a circle owner to leave via group cleanup', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'user-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: CircleMemberRole.OWNER,
      status: CircleMemberStatus.ACTIVE,
    });

    await expect(service.leaveGroup('user-1', 'group-1')).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'user-1',
    ]);
    expect(prisma.circleMember.delete).not.toHaveBeenCalled();
  });

  it('passes group leave through the controller with the current user', async () => {
    const serviceMock = {
      leaveGroup: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new GroupController(serviceMock as any);

    await controller.leaveGroup('group-1', {
      user: { userId: 'user-1' },
    } as any);

    expect(serviceMock.leaveGroup).toHaveBeenCalledWith('user-1', 'group-1');
  });

  it('invites circle group members through backend state and queues OpenIM sync', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([
      {
        userID: 'existing-pending',
        status: CircleMemberStatus.PENDING,
      },
    ]);
    prisma.circle.findUnique.mockResolvedValue({
      maxMembers: null,
      memberCount: 5,
    });
    prisma.circleMember.updateMany.mockResolvedValue({ count: 1 });
    prisma.circleMember.createMany.mockResolvedValue({ count: 1 });
    prisma.circle.update.mockResolvedValue({});

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user', 'existing-pending', 'new-user', '  '],
      }),
    ).resolves.toEqual({ handled: true });

    expect(prisma.circleMember.findUnique).toHaveBeenCalledWith({
      where: { userID_circleID: { userID: 'admin-1', circleID: 'circle-1' } },
      select: { id: true, role: true, status: true },
    });
    expect(prisma.circleMember.findMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        userID: { in: ['new-user', 'existing-pending'] },
      },
      select: { userID: true, status: true },
    });
    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'new-user',
      'existing-pending',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
    // Membership writes and locks are owned by the admission policy.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.create).not.toHaveBeenCalled();
    expect(prisma.circleMember.update).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'ADD_MEMBER',
          groupID: 'group-1',
          userID: 'existing-pending',
        },
        { operation: 'ADD_MEMBER', groupID: 'group-1', userID: 'new-user' },
      ],
      skipDuplicates: true,
    });
    expect(openim.addGroupMembers).not.toHaveBeenCalled();
    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['new-user', 'existing-pending'],
      { locksHeld: true, actor: 'third-party' },
    );
  });

  // Regression: memberCount used to be incremented by the size of the
  // pre-transaction snapshot, so a target that joined concurrently was counted
  // a second time and the circle drifted permanently.
  it('derives the memberCount increment from the rows the writes changed', async () => {
    admissionPolicy.activateMembers.mockResolvedValueOnce(['new-user']);
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    // The complete request is locked before this authoritative read. The
    // racer is now ACTIVE, so it stays idempotent while new-user is admitted.
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'racer', status: CircleMemberStatus.ACTIVE },
    ]);
    prisma.circle.findUnique.mockResolvedValue({
      maxMembers: null,
      memberCount: 5,
    });
    prisma.circleMember.createMany.mockResolvedValue({ count: 1 });
    prisma.circle.update.mockResolvedValue({});

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user', 'racer'],
      }),
    ).resolves.toEqual({ handled: true });

    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        { operation: 'ADD_MEMBER', groupID: 'group-1', userID: 'new-user' },
      ],
      skipDuplicates: true,
    });
    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'new-user',
      'racer',
    ]);
    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['new-user'],
      { locksHeld: true, actor: 'third-party' },
    );
  });

  it('does not admit a batch after the locked inviter has left', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue(null);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['target-a', 'target-b'],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'target-a',
      'target-b',
    ]);
    expect(admissionPolicy.activateMembers).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).not.toHaveBeenCalled();
  });

  it('rejects a group invite that would exceed the circle member limit', async () => {
    admissionPolicy.activateMembers.mockRejectedValueOnce(
      new BadRequestException('Circle has reached its member limit'),
    );
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      maxMembers: 10,
      memberCount: 8,
    });
    prisma.circleMember.createMany.mockResolvedValue({ count: 3 });
    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['a', 'b', 'c'],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).not.toHaveBeenCalled();
  });

  it('admits a group invite that exactly fills the circle', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.circle.findUnique.mockResolvedValue({
      maxMembers: 10,
      memberCount: 8,
    });
    prisma.circleMember.createMany.mockResolvedValue({ count: 2 });
    prisma.circle.update.mockResolvedValue({});

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['a', 'b'],
      }),
    ).resolves.toEqual({ handled: true });

    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['a', 'b'],
      { locksHeld: true, actor: 'third-party' },
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it('leaves the whole direct-invite batch unwritten when one user is over joined quota', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    admissionPolicy.activateMembers.mockRejectedValueOnce(
      new ForbiddenException({
        // 这条路径以第三方视角调用，真实策略回的是不带额度细节的 target 码。
        errorCode: 'CIRCLE_TARGET_JOIN_LIMIT_REACHED',
      }),
    );

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['allowed-user', 'over-quota-user', 'allowed-user'],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['allowed-user', 'over-quota-user'],
      { locksHeld: true, actor: 'third-party' },
    );
    expect(prisma.circleMember.createMany).not.toHaveBeenCalled();
    expect(prisma.circleMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).not.toHaveBeenCalled();
  });

  it('rejects circle group invites blocked by the target privacy setting', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    prisma.userPrivacySetting.findMany.mockResolvedValue([
      { userID: 'new-user', groupInvitePermission: 'NONE' },
    ]);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user'],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.groupSyncOutbox.createMany).not.toHaveBeenCalled();
  });

  it('allows FRIENDS_ONLY invites when the locked bulk friendship read finds the inviter', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);
    // admin-1 is an accepted friend of new-user (stored friendID side).
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'admin-1', friendID: 'new-user' },
    ]);
    prisma.userPrivacySetting.findMany.mockResolvedValue([
      { userID: 'new-user', groupInvitePermission: 'FRIENDS_ONLY' },
    ]);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user'],
      }),
    ).resolves.toEqual({ handled: true });

    expect(prisma.friend.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.userPrivacySetting.findMany).toHaveBeenCalledTimes(1);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.friend.findMany.mock.invocationCallOrder[0],
    );
  });

  it('uses two bounded transaction reads for a 100-target privacy check', async () => {
    const targetUserIDs = Array.from(
      { length: 100 },
      (_, index) => `target-${index}`,
    );
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'actor-member',
      role: CircleMemberRole.ADMIN,
      status: CircleMemberStatus.ACTIVE,
    });
    prisma.circleMember.findMany.mockResolvedValue([]);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: targetUserIDs,
      }),
    ).resolves.toEqual({ handled: true });

    expect(prisma.friend.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.friend.findMany).toHaveBeenCalledWith({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: 'admin-1', friendID: { in: targetUserIDs } },
          { friendID: 'admin-1', userID: { in: targetUserIDs } },
        ],
      },
      select: { userID: true, friendID: true },
    });
    expect(prisma.userPrivacySetting.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.userPrivacySetting.findMany).toHaveBeenCalledWith({
      where: { userID: { in: targetUserIDs } },
      select: { userID: true, groupInvitePermission: true },
    });
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.userPrivacySetting.findMany.mock.invocationCallOrder[0],
    );
    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      targetUserIDs,
      { locksHeld: true, actor: 'third-party' },
    );
  });

  it('returns unhandled for raw OpenIM group invites', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user'],
      }),
    ).resolves.toEqual({ handled: false });

    expect(prisma.circleMember.findUnique).not.toHaveBeenCalled();
    expect(openim.addGroupMembers).not.toHaveBeenCalled();
  });

  it('removes circle group members through backend state and queues OpenIM sync', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({
        id: 'actor-member',
        role: CircleMemberRole.ADMIN,
        status: CircleMemberStatus.ACTIVE,
      })
      .mockResolvedValueOnce({
        id: 'target-member',
        role: CircleMemberRole.MEMBER,
        status: CircleMemberStatus.ACTIVE,
      });
    prisma.userDisplayIcon.deleteMany.mockResolvedValue({});
    prisma.circleMember.delete.mockResolvedValue({});
    prisma.circle.update.mockResolvedValue({});
    prisma.conversationGroupMembership.deleteMany.mockResolvedValue({});

    await expect(
      service.removeGroupMember('admin-1', 'group-1', 'target-user'),
    ).resolves.toEqual({ handled: true });

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'target-user',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
    expect(prisma.circleMember.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.userDisplayIcon.deleteMany).toHaveBeenCalledWith({
      where: { userID: 'target-user', circleID: 'circle-1' },
    });
    expect(prisma.circleMember.delete).toHaveBeenCalledWith({
      where: { id: 'target-member' },
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { memberCount: { decrement: 1 } },
    });
    expect(prisma.circleInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        applicantID: 'target-user',
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
    expect(prisma.conversationGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: {
        conversationID: { in: ['group-1', 'sg_group-1'] },
        group: { ownerID: 'target-user' },
      },
    });
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_MEMBER',
          groupID: 'group-1',
          userID: 'target-user',
        },
      ],
      skipDuplicates: true,
    });
    expect(openim.removeGroupMember).not.toHaveBeenCalled();
  });

  it('locks and re-reads actor and a concurrently reactivated target before removal', async () => {
    let insideTransaction = false;
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      insideTransaction = true;
      return callback(prisma);
    });
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique.mockImplementation(({ where }) => {
      const userID = where.userID_circleID.userID;
      if (userID === 'admin-1') {
        return Promise.resolve({
          id: 'actor-member',
          role: CircleMemberRole.ADMIN,
          status: CircleMemberStatus.ACTIVE,
        });
      }
      return Promise.resolve({
        id: 'target-member',
        role: CircleMemberRole.MEMBER,
        status: insideTransaction
          ? CircleMemberStatus.ACTIVE
          : CircleMemberStatus.PENDING,
      });
    });

    await service.removeGroupMember('admin-1', 'group-1', 'target-user');

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'target-user',
    ]);
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { memberCount: { decrement: 1 } },
    });
  });

  it('does not allow a circle admin to remove another manager', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({
        id: 'actor-member',
        role: CircleMemberRole.ADMIN,
        status: CircleMemberStatus.ACTIVE,
      })
      .mockResolvedValueOnce({
        id: 'target-member',
        role: CircleMemberRole.ADMIN,
        status: CircleMemberStatus.ACTIVE,
      });

    await expect(
      service.removeGroupMember('admin-1', 'group-1', 'target-user'),
    ).rejects.toThrow(ForbiddenException);

    expect(openim.removeGroupMember).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'target-user',
    ]);
    expect(prisma.circleMember.delete).not.toHaveBeenCalled();
  });

  it('still removes an OpenIM member when local circle membership is already missing', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({
        id: 'actor-member',
        role: CircleMemberRole.ADMIN,
        status: CircleMemberStatus.ACTIVE,
      })
      .mockResolvedValueOnce(null);
    prisma.conversationGroupMembership.deleteMany.mockResolvedValue({});

    await expect(
      service.removeGroupMember('admin-1', 'group-1', 'target-user'),
    ).resolves.toEqual({ handled: true });

    expect(prisma.conversationGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: {
        conversationID: { in: ['group-1', 'sg_group-1'] },
        group: { ownerID: 'target-user' },
      },
    });
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_MEMBER',
          groupID: 'group-1',
          userID: 'target-user',
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.circleInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        applicantID: 'target-user',
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
    expect(openim.removeGroupMember).not.toHaveBeenCalled();
  });

  it('returns unhandled for raw OpenIM group removals', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);

    await expect(
      service.removeGroupMember('admin-1', 'group-1', 'target-user'),
    ).resolves.toEqual({ handled: false });

    expect(openim.removeGroupMember).not.toHaveBeenCalled();
  });

  it('validates administrator role changes against the public enum', () => {
    const Dto = (groupMemberDtos as any).UpdateGroupMemberRoleDto;
    expect(typeof Dto).toBe('function');
    expect(validateSync(plainToInstance(Dto, { role: 'ADMIN' }))).toHaveLength(
      0,
    );
    expect(
      validateSync(plainToInstance(Dto, { role: 'OWNER' })),
    ).not.toHaveLength(0);
  });

  it('passes member role changes through the controller with the current user', async () => {
    const serviceMock = {
      updateGroupMemberRole: jest
        .fn()
        .mockResolvedValue({ handled: true, role: 'ADMIN' }),
    };
    const controller = new GroupController(serviceMock as any);

    expect(typeof (controller as any).updateGroupMemberRole).toBe('function');
    await expect(
      (controller as any).updateGroupMemberRole(
        'group-1',
        'target-1',
        { role: 'ADMIN' },
        { user: { userId: 'owner-1' } },
      ),
    ).resolves.toEqual({ handled: true, role: 'ADMIN' });

    expect(serviceMock.updateGroupMemberRole).toHaveBeenCalledWith(
      'owner-1',
      'group-1',
      'target-1',
      { role: 'ADMIN' },
    );
  });

  it('lets a circle owner promote an active member and syncs OpenIM', async () => {
    expect(typeof (service as any).updateGroupMemberRole).toBe('function');
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({
        id: 'owner-member',
        role: CircleMemberRole.OWNER,
        status: CircleMemberStatus.ACTIVE,
      })
      .mockResolvedValueOnce({
        id: 'target-member',
        role: CircleMemberRole.MEMBER,
        status: CircleMemberStatus.ACTIVE,
      });
    prisma.circleMember.update.mockResolvedValue({});

    await expect(
      (service as any).updateGroupMemberRole(
        'owner-1',
        'group-1',
        'target-user',
        { role: 'ADMIN' },
      ),
    ).resolves.toEqual({ handled: true, role: 'ADMIN' });

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'owner-1',
      'target-user',
    ]);
    expect(prisma.circleMember.update).toHaveBeenCalledWith({
      where: { id: 'target-member' },
      data: { role: CircleMemberRole.ADMIN },
    });
    expect(openim.setGroupMemberRole).toHaveBeenCalledWith(
      'group-1',
      'target-user',
      60,
    );
  });

  it('rejects administrator attempts to grant administrator role', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      groupID: 'group-1',
      ownerID: 'owner-1',
    });
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({
        id: 'admin-member',
        role: CircleMemberRole.ADMIN,
        status: CircleMemberStatus.ACTIVE,
      })
      .mockResolvedValueOnce({
        id: 'target-member',
        role: CircleMemberRole.MEMBER,
        status: CircleMemberStatus.ACTIVE,
      });

    await expect(
      (service as any).updateGroupMemberRole(
        'admin-1',
        'group-1',
        'target-user',
        { role: 'ADMIN' },
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.circleMember.update).not.toHaveBeenCalled();
    expect(openim.setGroupMemberRole).not.toHaveBeenCalled();
  });

  it('verifies the owner in OpenIM before changing a raw group role', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);
    openim.getGroupMemberRole
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(20);

    await expect(
      (service as any).updateGroupMemberRole(
        'owner-1',
        'raw-group',
        'target-user',
        { role: 'ADMIN' },
      ),
    ).resolves.toEqual({ handled: true, role: 'ADMIN' });

    expect(openim.setGroupMemberRole).toHaveBeenCalledWith(
      'raw-group',
      'target-user',
      60,
    );
  });
});
