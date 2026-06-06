import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
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
    circleActivity: {
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  const openimService = {
    createGroup: jest.fn(),
    addGroupMembers: jest.fn(),
    removeGroupMember: jest.fn(),
  };

  const realtimeService = {
    broadcastCircleUnreadCount: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpenimService, useValue: openimService },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        { provide: RealtimeService, useValue: realtimeService },
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
      realtimeService as any,
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

  it('broadcasts updated circle unread count after marking an activity read', async () => {
    prisma.circleActivity.updateMany.mockResolvedValue({ count: 1 });

    await service.markActivityRead('user-1', 'activity-1');

    expect(realtimeService.broadcastCircleUnreadCount).toHaveBeenCalledWith(
      'user-1',
    );
  });

  describe('markAllActivitiesRead', () => {
    it('marks all unread as read and broadcasts when count > 0', async () => {
      prisma.circleActivity.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.markAllActivitiesRead('user-1');

      expect(result).toEqual({ count: 3 });
      expect(prisma.circleActivity.updateMany).toHaveBeenCalledWith({
        where: { viewerID: 'user-1', readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(realtimeService.broadcastCircleUnreadCount).toHaveBeenCalledWith(
        'user-1',
      );
    });

    it('does not broadcast when nothing changed', async () => {
      prisma.circleActivity.updateMany.mockResolvedValue({ count: 0 });
      await service.markAllActivitiesRead('user-1');
      expect(realtimeService.broadcastCircleUnreadCount).not.toHaveBeenCalled();
    });
  });

  describe('getActivities post excerpt', () => {
    it('includes post excerpt for signup activities', async () => {
      prisma.circleActivity.findMany.mockResolvedValue([
        {
          id: 'a1',
          type: 'POST_SIGNUP_RECEIVED',
          invitationID: null,
          readAt: null,
          createdAt: new Date('2026-06-05T00:00:00Z'),
          circle: { id: 'c1', name: 'C' },
          actor: { id: 'u2', nickname: 'B', avatarUrl: null, accountId: '2' },
          post: { id: 'p1', content: 'Hiking this weekend, who is in?' },
        },
      ]);

      const result = await service.getActivities('user-1');

      expect(result[0].post).toEqual({
        id: 'p1',
        excerpt: 'Hiking this weekend, who is in?',
      });
    });
  });
});
