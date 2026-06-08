import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CircleService } from './circle.service';

describe('CircleService', () => {
  let service: CircleService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    circle: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    iconAsset: {
      findFirst: jest.fn(),
      create: jest.fn(),
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
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  const openimService = {
    createGroup: jest.fn(),
    addGroupMembers: jest.fn(),
    removeGroupMember: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpenimService, useValue: openimService },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
      ],
    }).compile();

    service = module.get(CircleService);
  });

  it('rejects joining when the user does not satisfy circle restrictions', async () => {
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      isPublic: true,
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

  it('rejects createCircle with an off-origin avatarUrl when MinIO is configured', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    const guarded = new CircleService(
      prisma as any,
      openimService as any,
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
});
