import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CircleMemberRole, CircleMemberStatus } from 'src/generated/prisma';
import { JwtGuard } from 'src/guards/jwt.guard';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';

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
    };
    groupReport: {
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    friend: { findMany: jest.Mock };
    userDisplayIcon: { deleteMany: jest.Mock };
  };
  let openim: {
    addGroupMembers: jest.Mock;
    isGroupMember: jest.Mock;
    removeGroupMember: jest.Mock;
  };
  let privacySettings: {
    canBeInvitedToGroupOrCircle: jest.Mock;
  };
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
      },
      groupReport: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      friend: { findMany: jest.fn().mockResolvedValue([]) },
      userDisplayIcon: { deleteMany: jest.fn() },
    };
    openim = {
      addGroupMembers: jest.fn().mockResolvedValue(undefined),
      isGroupMember: jest.fn().mockResolvedValue(false),
      removeGroupMember: jest.fn().mockResolvedValue(undefined),
    };
    privacySettings = {
      canBeInvitedToGroupOrCircle: jest.fn().mockResolvedValue(true),
    };
    service = new GroupService(
      prisma as any,
      openim as any,
      privacySettings as any,
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
    expect(prisma.conversationGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: {
        conversationID: { in: ['group-1', 'sg_group-1'] },
        group: { ownerID: 'user-1' },
      },
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

    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    // The pair locks every other membership path takes, in one round-trip.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // Batched writes: no per-user create/update round-trip inside the tx.
    expect(prisma.circleMember.createMany).toHaveBeenCalledWith({
      data: [
        {
          userID: 'new-user',
          circleID: 'circle-1',
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.ACTIVE,
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.circleMember.updateMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        userID: { in: ['existing-pending'] },
        status: { not: CircleMemberStatus.ACTIVE },
      },
      data: {
        role: CircleMemberRole.MEMBER,
        status: CircleMemberStatus.ACTIVE,
      },
    });
    expect(prisma.circleMember.create).not.toHaveBeenCalled();
    expect(prisma.circleMember.update).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([2, 'circle-1', 2]);
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        { operation: 'ADD_MEMBER', groupID: 'group-1', userID: 'new-user' },
        {
          operation: 'ADD_MEMBER',
          groupID: 'group-1',
          userID: 'existing-pending',
        },
      ],
      skipDuplicates: true,
    });
    expect(openim.addGroupMembers).not.toHaveBeenCalled();
  });

  // Regression: memberCount used to be incremented by the size of the
  // pre-transaction snapshot, so a target that joined concurrently was counted
  // a second time and the circle drifted permanently.
  it('derives the memberCount increment from the rows the writes changed', async () => {
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
    // Pre-check sees both as invitable...
    prisma.circleMember.findMany
      .mockResolvedValueOnce([
        { userID: 'racer', status: CircleMemberStatus.PENDING },
      ])
      // ...but under the lock `racer` has already been activated by a
      // concurrent join, leaving only one real seat to take.
      .mockResolvedValueOnce([
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
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([1, 'circle-1', 1]);
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        { operation: 'ADD_MEMBER', groupID: 'group-1', userID: 'new-user' },
      ],
      skipDuplicates: true,
    });
  });

  it('rejects a group invite that would exceed the circle member limit', async () => {
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
    // The membership writes happen first inside the transaction; a failed
    // atomic reservation then rolls them back.
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

    expect(prisma.circleMember.createMany).toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
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

    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([2, 'circle-1', 2]);
    expect(prisma.circle.update).not.toHaveBeenCalled();
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
    privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(false);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user'],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).not.toHaveBeenCalled();
  });

  it('passes real friendship status to the group invite privacy check (FRIENDS_ONLY)', async () => {
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
    // Block before the transaction so we only assert the privacy-check args.
    privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(false);

    await expect(
      service.inviteGroupMembers('admin-1', 'group-1', {
        userIDs: ['new-user'],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(privacySettings.canBeInvitedToGroupOrCircle).toHaveBeenCalledWith(
      'new-user',
      true,
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
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    expect(openim.removeGroupMember).not.toHaveBeenCalled();
  });

  it('returns unhandled for raw OpenIM group removals', async () => {
    prisma.circle.findFirst.mockResolvedValue(null);

    await expect(
      service.removeGroupMember('admin-1', 'group-1', 'target-user'),
    ).resolves.toEqual({ handled: false });

    expect(openim.removeGroupMember).not.toHaveBeenCalled();
  });
});
