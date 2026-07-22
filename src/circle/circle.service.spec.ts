import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { CircleAdmissionPolicy } from './circle-admission-policy';
import { CircleMemberLockService } from './circle-member-lock';
import {
  CreateCircleDto,
  SetCircleAvatarDto,
  SetCircleCoverDto,
  UploadCircleIconDto,
} from './dto/circle.dto';
import { CircleService } from './circle.service';

describe('CircleService', () => {
  let service: CircleService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    circle: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    iconAsset: {
      findFirst: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    circleMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    userDisplayIcon: {
      deleteMany: jest.fn(),
    },
    circleInvitation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    groupSyncOutbox: {
      createMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  const openimService = {
    createGroup: jest.fn(),
    addGroupMembers: jest.fn(),
    removeGroupMember: jest.fn(),
  };

  const circleInvitationService = {
    getInvitationForViewer: jest.fn(),
  };
  const memberLock = { lock: jest.fn() };
  const directMembershipPolicy = new MembershipPolicyService(prisma as any);
  const directMemberLock = new CircleMemberLockService(directMembershipPolicy);
  const directAdmissionPolicy = new CircleAdmissionPolicy(
    directMembershipPolicy,
    directMemberLock,
  );

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpenimService, useValue: openimService },
        { provide: CircleInvitationService, useValue: circleInvitationService },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        MembershipPolicyService,
        CircleAdmissionPolicy,
        { provide: CircleMemberLockService, useValue: memberLock },
      ],
    }).compile();

    service = module.get(CircleService);
    circleInvitationService.getInvitationForViewer.mockResolvedValue({
      id: 'inv-1',
      status: 'PENDING',
    });
    prisma.circleInvitation.create.mockResolvedValue({ id: 'inv-1' });
  });

  it('rejects joining when the user does not satisfy circle restrictions', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      memberCount: 3,
      maxMembers: 10,
      joinVipRestriction: 3,
      joinCreditRestriction: 80,
      joinFancyRestriction: true,
      groupID: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 2,
      vipExpiresAt: null,
      creditScore: 90,
      fancyNumber: true,
    });

    await expect(service.joinCircle('user-1', 'circle-1')).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.circleMember.create).not.toHaveBeenCalled();
    expect(prisma.circleMember.update).not.toHaveBeenCalled();
  });

  it('returns a pending invitation for every join', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      memberCount: 3,
      maxMembers: null,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
      groupID: 'group-1',
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      vipExpiresAt: null,
      creditScore: 100,
      fancyNumber: null,
    });
    prisma.circleMember.findUnique.mockResolvedValue(null);
    prisma.circleInvitation.findFirst.mockResolvedValue(null);

    const result = await service.joinCircle('user-1', 'circle-1');

    expect(result).toEqual(expect.objectContaining({ id: 'inv-1' }));
    expect(circleInvitationService.getInvitationForViewer).toHaveBeenCalledWith(
      'user-1',
      'inv-1',
    );

    expect(prisma.circleMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    // 申请人自任 inviter 的担保单（0/10 起步），驱动「邀请好友为我验证」入口。
    expect(prisma.circleInvitation.create).toHaveBeenCalledWith({
      data: {
        circleID: 'circle-1',
        applicantID: 'user-1',
        inviterID: 'user-1',
      },
      select: { id: true },
    });
    // PENDING 不占正式名额、不进 OpenIM 群——转正统一发生在担保 finalize。
    expect(prisma.circle.update).not.toHaveBeenCalled();
    expect(openimService.addGroupMembers).not.toHaveBeenCalled();
  });

  it('join reuses an existing pending invitation instead of duplicating it', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      memberCount: 3,
      maxMembers: null,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
      groupID: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      vipExpiresAt: null,
      creditScore: 100,
      fancyNumber: null,
    });
    prisma.circleMember.findUnique.mockResolvedValue(null);
    prisma.circleInvitation.findFirst.mockResolvedValue({ id: 'inv-1' });

    await service.joinCircle('user-1', 'circle-1');

    expect(prisma.circleInvitation.create).not.toHaveBeenCalled();
  });

  it('repairs a legacy pending membership that has no invitation', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      memberCount: 3,
      maxMembers: null,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
      groupID: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      vipExpiresAt: null,
      creditScore: 100,
      fancyNumber: null,
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      status: 'PENDING',
      role: 'MEMBER',
    });
    prisma.circleInvitation.findFirst.mockResolvedValue(null);
    prisma.circleInvitation.create.mockResolvedValue({ id: 'inv-legacy' });

    await service.joinCircle('user-1', 'circle-1');

    expect(prisma.circleInvitation.create).toHaveBeenCalledWith({
      data: {
        circleID: 'circle-1',
        applicantID: 'user-1',
        inviterID: 'user-1',
      },
      select: { id: true },
    });
    expect(circleInvitationService.getInvitationForViewer).toHaveBeenCalledWith(
      'user-1',
      'inv-legacy',
    );
  });

  it('moves a rejected membership back to pending when the user reapplies', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      memberCount: 3,
      maxMembers: null,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
      groupID: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      vipExpiresAt: null,
      creditScore: 100,
      fancyNumber: null,
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-rejected',
      status: 'REJECTED',
      role: 'MEMBER',
    });
    prisma.circleInvitation.findFirst.mockResolvedValue(null);

    await service.joinCircle('user-1', 'circle-1');

    expect(prisma.circleMember.update).toHaveBeenCalledWith({
      where: { id: 'member-rejected' },
      data: { status: 'PENDING', role: 'MEMBER' },
    });
    expect(prisma.circleMember.create).not.toHaveBeenCalled();
  });

  it('reports an existing ACTIVE membership before changed capacity or restrictions', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      memberCount: 10,
      maxMembers: 10,
      joinVipRestriction: 4,
      joinCreditRestriction: 100,
      joinFancyRestriction: true,
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      status: 'ACTIVE',
      role: 'MEMBER',
    });

    await expect(
      service.joinCircle('user-1', 'circle-1'),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_ALREADY_MEMBER' },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('cancels pending invitations when a pending member leaves', async () => {
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: 'MEMBER',
      status: 'PENDING',
    });
    prisma.circle.findUnique.mockResolvedValue({ groupID: null });

    await service.leaveCircle('user-1', 'circle-1');

    expect(prisma.circleInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        circleID: 'circle-1',
        applicantID: 'user-1',
        status: 'PENDING',
      },
      data: { status: 'CANCELLED' },
    });
  });

  it('uses the locked membership state when approval races with leave', async () => {
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    prisma.circle.findUnique.mockResolvedValue({ groupID: null });

    await service.leaveCircle('user-1', 'circle-1');

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'user-1',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
    expect(prisma.circleMember.findUnique).toHaveBeenCalledTimes(1);
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
  });

  it('durably queues the latest REMOVE state when leaving an OpenIM-backed circle', async () => {
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    prisma.circle.findUnique.mockResolvedValue({ groupID: 'group-1' });

    await service.leaveCircle('user-1', 'circle-1');

    expect(prisma.groupSyncOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        groupID: 'group-1',
        userID: { in: ['user-1'] },
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lockedAt: null,
        lastError: 'Superseded by desired REMOVE_MEMBER state',
      },
    });
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_MEMBER',
          groupID: 'group-1',
          userID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('rejects createCircle with an off-origin avatarUrl when MinIO is configured', async () => {
    const guarded = new CircleService(
      prisma as any,
      openimService as any,
      circleInvitationService as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
      directMembershipPolicy,
      directAdmissionPolicy,
      directMemberLock,
    );
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: null,
    });

    await expect(
      guarded.createCircle('user-1', {
        name: 'Evil Circle',
        categories: ['LIFE'],
        description: 'a'.repeat(20),
        avatarUrl: 'https://evil.example.com/track.gif',
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects createCircle when a free-form category is blank after trimming', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: null,
    });

    await expect(
      service.createCircle('user-1', {
        name: 'Food Circle',
        categories: ['food', '   '],
        description: 'a'.repeat(20),
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  const membershipTiers = [
    { level: 0, capacity: 100 },
    { level: 1, capacity: 300 },
    { level: 2, capacity: 500 },
    { level: 3, capacity: 1000 },
    { level: 4, capacity: 3000 },
  ];

  const validCircle = (maxMembers?: number): CreateCircleDto => ({
    name: 'Capacity Circle',
    categories: ['test'],
    description: 'a valid circle description',
    ...(maxMembers === undefined ? {} : { maxMembers }),
  });

  const circleRecord = (maxMembers: number) => ({
    id: 'circle-1',
    name: 'Capacity Circle',
    description: 'a valid circle description',
    avatarUrl: null,
    ownerID: 'user-1',
    cities: [],
    categories: ['test'],
    rules: '',
    tags: [],
    joinVipRestriction: null,
    joinCreditRestriction: null,
    joinFancyRestriction: false,
    maxMembers,
    memberCanPost: true,
    groupID: null,
    memberCount: 1,
    postCount: 0,
    createdAt: new Date('2026-07-21T12:00:00.000Z'),
  });

  it.each(membershipTiers)(
    'defaults stored level $level circle capacity to $capacity',
    async ({ level, capacity }) => {
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: level,
        vipExpiresAt: null,
      });
      prisma.circle.create.mockResolvedValue(circleRecord(capacity));

      await service.createCircle('user-1', validCircle());

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { vipLevel: true, vipExpiresAt: true },
      });
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.user.findUnique.mock.invocationCallOrder[0],
      );
      expect(prisma.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.circle.create.mock.invocationCallOrder[0],
      );
      expect(prisma.circle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ maxMembers: capacity }),
      });
    },
  );

  it.each(membershipTiers)(
    'allows stored level $level at exact circle capacity $capacity',
    async ({ level, capacity }) => {
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: level,
        vipExpiresAt: null,
      });
      prisma.circle.create.mockResolvedValue(circleRecord(capacity));

      await service.createCircle('user-1', validCircle(capacity));

      expect(prisma.circle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ maxMembers: capacity }),
      });
    },
  );

  it.each(membershipTiers)(
    'rejects stored level $level above circle capacity $capacity',
    async ({ level, capacity }) => {
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: level,
        vipExpiresAt: null,
      });

      await expect(
        service.createCircle('user-1', validCircle(capacity + 1)),
      ).rejects.toMatchObject({
        response: {
          errorCode: 'MEMBERSHIP_GROUP_MEMBER_CAPACITY_EXCEEDED',
        },
      });
      expect(prisma.circle.create).not.toHaveBeenCalled();
      expect(prisma.circleMember.create).not.toHaveBeenCalled();
    },
  );

  it('falls back to regular capacity when a paid membership is expired', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    prisma.circle.create.mockResolvedValue(circleRecord(100));

    await service.createCircle('user-1', validCircle());

    expect(prisma.circle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ maxMembers: 100 }),
    });
  });

  it('rejects expired paid membership above regular capacity', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(
      service.createCircle('user-1', validCircle(101)),
    ).rejects.toMatchObject({
      response: { errorCode: 'MEMBERSHIP_GROUP_MEMBER_CAPACITY_EXCEEDED' },
    });
    expect(prisma.circle.create).not.toHaveBeenCalled();
  });

  it('stores legacy joinVipRestriction zero as no restriction', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: null,
    });
    prisma.circle.create.mockResolvedValue({
      id: 'circle-1',
      name: 'Food Circle',
      description: 'a'.repeat(20),
      avatarUrl: null,
      ownerID: 'user-1',
      cities: [],
      categories: ['food'],
      rules: '',
      tags: [],
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
      maxMembers: null,
      memberCanPost: true,
      groupID: null,
      memberCount: 1,
      postCount: 0,
      createdAt: new Date('2026-07-21T12:00:00.000Z'),
    });

    await service.createCircle('user-1', {
      name: 'Food Circle',
      categories: ['food'],
      description: 'a'.repeat(20),
      joinVipRestriction: 0,
    });

    expect(prisma.circle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ joinVipRestriction: null }),
    });
  });

  it('rejects a join VIP restriction above the creator effective membership', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 2,
      vipExpiresAt: null,
    });

    await expect(
      service.createCircle('user-1', {
        ...validCircle(),
        joinVipRestriction: 3,
      }),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'CIRCLE_JOIN_VIP_RESTRICTION_EXCEEDS_CREATOR',
        limit: 2,
      },
    });
    expect(prisma.circle.create).not.toHaveBeenCalled();
    expect(prisma.circleMember.create).not.toHaveBeenCalled();
  });

  it('uses the creator effective regular level after paid membership expiry', async () => {
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 3,
      vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(
      service.createCircle('user-1', {
        ...validCircle(),
        joinVipRestriction: 1,
      }),
    ).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_JOIN_VIP_RESTRICTION_EXCEEDS_CREATOR' },
    });
    expect(prisma.circle.create).not.toHaveBeenCalled();
  });

  it('lets the circle owner update the cover image', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      ownerID: 'owner-1',
      deleted: false,
    });
    prisma.circle.update.mockResolvedValue({});

    await service.setCircleCover(
      'owner-1',
      'circle-1',
      'https://cdn.example.com/covers/circle-1.png',
    );

    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { cover: 'https://cdn.example.com/covers/circle-1.png' },
    });
  });

  it('rejects setCircleAvatar with an off-origin URL when MinIO is configured', async () => {
    const guarded = new CircleService(
      prisma as any,
      openimService as any,
      circleInvitationService as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
      directMembershipPolicy,
      directAdmissionPolicy,
      directMemberLock,
    );
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      ownerID: 'owner-1',
      deleted: false,
    });

    await expect(
      guarded.setCircleAvatar(
        'owner-1',
        'circle-1',
        'https://evil.example.com/avatar.png',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  // Regression: uploadCircleIcon was the one owner-write path without the
  // origin guard, and the icon is rendered to every plaza viewer as a badge.
  it('rejects uploadCircleIcon with an off-origin URL when MinIO is configured', async () => {
    const guarded = new CircleService(
      prisma as any,
      openimService as any,
      circleInvitationService as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
      directMembershipPolicy,
      directAdmissionPolicy,
      directMemberLock,
    );
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      ownerID: 'owner-1',
      deleted: false,
    });
    // Mocked so that, without the guard, the upload would succeed — the
    // rejection below can only come from the origin check itself.
    prisma.iconAsset.create.mockResolvedValue({
      id: 'asset-evil',
      imageUrl: 'https://evil.example.com/icon.png',
    });

    await expect(
      guarded.uploadCircleIcon('owner-1', 'circle-1', {
        imageUrl: 'https://evil.example.com/icon.png',
        name: 'evil',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.iconAsset.create).not.toHaveBeenCalled();
  });

  it('accepts uploadCircleIcon for a URL served from this app storage', async () => {
    const guarded = new CircleService(
      prisma as any,
      openimService as any,
      circleInvitationService as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
      directMembershipPolicy,
      directAdmissionPolicy,
      directMemberLock,
    );
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      ownerID: 'owner-1',
      deleted: false,
    });
    prisma.iconAsset.create.mockResolvedValue({
      id: 'asset-new',
      imageUrl: 'http://10.0.0.195:9000/avatars/new.png',
    });

    await expect(
      guarded.uploadCircleIcon('owner-1', 'circle-1', {
        imageUrl: 'http://10.0.0.195:9000/avatars/new.png',
        name: 'ok',
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'asset-new' }));
  });

  it('allows the circle owner to select the current circle icon', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      ownerID: 'owner-1',
      deleted: false,
      currentIconAssetID: null,
    });
    prisma.iconAsset.findFirst.mockResolvedValue({
      id: 'asset-1',
      sourceType: 'CIRCLE',
      circleID: 'circle-1',
      imageUrl: 'http://cdn.example/circle-icon.png',
    });

    await service.selectCircleIcon('owner-1', 'circle-1', {
      iconAssetId: 'asset-1',
    });

    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { currentIconAssetID: 'asset-1' },
    });
  });

  it('replaces the previous custom circle icon when uploading a new one', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      ownerID: 'owner-1',
      deleted: false,
    });
    prisma.iconAsset.create.mockResolvedValue({
      id: 'asset-new',
      name: 'new icon',
      imageUrl: 'http://localhost:9000/avatars/new.png',
      sourceType: 'CIRCLE',
      circleID: 'circle-1',
    });

    const result = await service.uploadCircleIcon('owner-1', 'circle-1', {
      imageUrl: 'http://localhost:9000/avatars/new.png',
      name: 'new icon',
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'asset-new',
        imageUrl: 'http://localhost:9000/avatars/new.png',
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.iconAsset.create).toHaveBeenCalledWith({
      data: {
        name: 'new icon',
        sourceType: 'CIRCLE',
        imageUrl: 'http://localhost:9000/avatars/new.png',
        circleID: 'circle-1',
        createdByID: 'owner-1',
      },
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { currentIconAssetID: 'asset-new' },
    });
    expect(prisma.iconAsset.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceType: 'CIRCLE',
        circleID: 'circle-1',
        id: { not: 'asset-new' },
      },
    });
  });

  // myCircles 必须自带 myRole —— 客户端「我管理的圈子」只需要这一个字段。不带的话
  // 前端只能对每个已加入圈子再打一次 GET /circle/:id 把它捞回来（N+1，且在主 Tab 上）。
  function circleRow(id: string) {
    return {
      id,
      name: id,
      description: '',
      avatarUrl: null,
      ownerID: 'owner-1',
      cities: [],
      categories: [],
      rules: [],
      tags: [],
      joinVipRestriction: 0,
      joinCreditRestriction: 0,
      joinFancyRestriction: false,
      maxMembers: 100,
      memberCanPost: true,
      groupID: null,
      memberCount: 1,
      postCount: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  it('myCircles(joined) reports each membership role so clients need no per-circle detail fetch', async () => {
    prisma.circleMember.findMany.mockResolvedValue([
      { role: 'ADMIN', circle: circleRow('circle-admin') },
      { role: 'MEMBER', circle: circleRow('circle-member') },
    ]);

    const result = await service.myCircles('user-1', { tab: 'joined' } as any);

    expect(result.map((c) => [c.id, c.myRole])).toEqual([
      ['circle-admin', 'ADMIN'],
      ['circle-member', 'MEMBER'],
    ]);
  });

  it('myCircles(created) reports OWNER', async () => {
    prisma.circle.findMany.mockResolvedValue([circleRow('circle-own')]);

    const result = await service.myCircles('user-1', { tab: 'created' } as any);

    expect(result).toHaveLength(1);
    expect(result[0].myRole).toBe('OWNER');
  });

  it('returns every created circle instead of silently truncating the list', async () => {
    prisma.circle.findMany.mockResolvedValue([]);

    await service.myCircles('user-1', { tab: 'created' });

    expect(prisma.circle.findMany).toHaveBeenCalledWith({
      where: { ownerID: 'user-1', deleted: false },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns every joined circle instead of silently truncating the list', async () => {
    prisma.circleMember.findMany.mockResolvedValue([]);

    await service.myCircles('user-1', { tab: 'joined' });

    expect(prisma.circleMember.findMany).toHaveBeenCalledWith({
      where: {
        userID: 'user-1',
        status: 'ACTIVE',
        role: { not: 'OWNER' },
        circle: { deleted: false },
      },
      include: { circle: true },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('circle DTO validation', () => {
  function validate(dto: new () => object, payload: Record<string, unknown>) {
    return validateSync(plainToInstance(dto, payload));
  }

  it('accepts local development asset URLs', () => {
    expect(
      validate(SetCircleCoverDto, {
        cover: 'http://localhost:9000/covers/circle.png',
      }),
    ).toHaveLength(0);
    expect(
      validate(SetCircleAvatarDto, {
        avatarUrl: 'http://localhost:9000/avatars/circle.png',
      }),
    ).toHaveLength(0);
    expect(
      validate(UploadCircleIconDto, {
        imageUrl: 'http://localhost:9000/avatars/circle-icon.png',
      }),
    ).toHaveLength(0);
  });

  it('rejects non-URL image fields before they reach the service', () => {
    const coverErrors = validate(SetCircleCoverDto, { cover: '/covers/a.png' });
    const avatarErrors = validate(SetCircleAvatarDto, {
      avatarUrl: 'javascript:alert(1)',
    });

    expect(coverErrors[0]?.constraints).toHaveProperty('isUrl');
    expect(avatarErrors[0]?.constraints).toHaveProperty('isUrl');
  });

  it.each([0, 1, 2, 3, 4])(
    'accepts compatible join VIP restriction %i',
    (joinVipRestriction) => {
      expect(
        validate(CreateCircleDto, {
          name: 'Test Circle',
          categories: ['test'],
          description: 'a valid circle description',
          joinVipRestriction,
        }),
      ).toHaveLength(0);
    },
  );

  it('accepts null as no join VIP restriction', () => {
    expect(
      validate(CreateCircleDto, {
        name: 'Test Circle',
        categories: ['test'],
        description: 'a valid circle description',
        joinVipRestriction: null,
      }),
    ).toHaveLength(0);
  });

  it('rejects join VIP restrictions above level 4', () => {
    const errors = validate(CreateCircleDto, {
      name: 'Test Circle',
      categories: ['test'],
      description: 'a valid circle description',
      joinVipRestriction: 5,
    });

    expect(
      errors.find((error) => error.property === 'joinVipRestriction'),
    ).toHaveProperty('constraints.max');
  });
});
