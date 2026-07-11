import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import {
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

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpenimService, useValue: openimService },
        { provide: CircleInvitationService, useValue: circleInvitationService },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
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

  it('rejects createCircle with an off-origin avatarUrl when MinIO is configured', async () => {
    const guarded = new CircleService(
      prisma as any,
      openimService as any,
      circleInvitationService as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
    );
    prisma.user.findUnique.mockResolvedValue({ vipLevel: 3 });

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
    prisma.user.findUnique.mockResolvedValue({ vipLevel: 3 });

    await expect(
      service.createCircle('user-1', {
        name: 'Food Circle',
        categories: ['food', '   '],
        description: 'a'.repeat(20),
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
});

describe('circle image DTO validation', () => {
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
});
