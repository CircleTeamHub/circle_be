import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationService } from 'src/notification/notification.service';
import { IconService } from 'src/icon/icon.service';
import { CirclePlazaService } from './circle-plaza.service';

describe('CirclePlazaService', () => {
  let service: CirclePlazaService;

  const prisma = {
    circleMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    block: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    note: {
      findFirst: jest.fn(),
    },
    circlePost: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    circlePostSignup: {
      findUnique: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    circle: {
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    circlePostCircle: {
      findMany: jest.fn(),
    },
    circlePostReport: {
      upsert: jest.fn(),
    },
    collaborationRecognition: {
      count: jest.fn(),
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
    userLike: {
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  const realtime = {
    broadcastSignupUnread: jest.fn(),
    broadcastInteractionUnread: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
  };
  const notificationService = {
    createCirclePostSignupNotification: jest.fn(),
    createCirclePostAutoEndedNotification: jest.fn(),
    createCollaborationRecognitionNotification: jest.fn(),
    createCirclePostPublishedNotifications: jest.fn(),
  };
  const iconService = {
    invalidateDisplayIconCacheFor: jest.fn(),
    getDisplayIconsForUsers: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    notificationService.createCirclePostSignupNotification.mockReset();
    notificationService.createCirclePostAutoEndedNotification.mockReset();
    notificationService.createCollaborationRecognitionNotification.mockReset();
    notificationService.createCollaborationRecognitionNotification.mockResolvedValue(
      null,
    );
    notificationService.createCirclePostPublishedNotifications.mockReset();
    notificationService.createCirclePostPublishedNotifications.mockResolvedValue(
      [],
    );
    prisma.block.findMany.mockReset();
    prisma.block.findMany.mockResolvedValue([]);
    iconService.getDisplayIconsForUsers.mockReset();
    iconService.getDisplayIconsForUsers.mockResolvedValue(new Map());
    prisma.collaborationRecognition.findMany.mockResolvedValue([]);
    prisma.userLike.findMany.mockResolvedValue([]);
    prisma.userLike.createMany.mockResolvedValue({ count: 0 });
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.circle.updateMany.mockResolvedValue({ count: 1 });
    prisma.circlePostCircle.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CirclePlazaService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        { provide: RealtimeService, useValue: realtime },
        { provide: NotificationService, useValue: notificationService },
        { provide: IconService, useValue: iconService },
      ],
    }).compile();

    service = module.get(CirclePlazaService);
  });

  describe('getFeed', () => {
    it('only returns posts from circles the viewer has actively joined', async () => {
      jest
        .useFakeTimers()
        .setSystemTime(new Date('2026-06-29T12:00:00Z').getTime());
      prisma.circlePost.findMany.mockResolvedValue([]);
      prisma.circlePost.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });

      try {
        const result = await service.getFeed('viewer-1', {});

        expect(result.items).toEqual([]);
        // M2M：可见性走关联表——某条 link 指向 viewer 是 ACTIVE 成员的圈子。
        const expectedMembershipScope = {
          circleLinks: {
            some: {
              circle: {
                deleted: false,
                members: {
                  some: { userID: 'viewer-1', status: 'ACTIVE' },
                },
              },
            },
          },
        };
        const expectedUnexpiredScope = [
          { expiresAt: { gt: new Date('2026-06-29T12:00:00.000Z') } },
          {
            expiresAt: null,
            createdAt: { gt: new Date('2026-06-28T12:00:00.000Z') },
          },
        ];
        expect(prisma.circlePost.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: 'ACTIVE',
              OR: expectedUnexpiredScope,
              ...expectedMembershipScope,
            }),
          }),
        );
        expect(prisma.circlePost.count).toHaveBeenCalledWith({
          where: expect.objectContaining({
            OR: expectedUnexpiredScope,
            ...expectedMembershipScope,
          }),
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps selected circle and city filters inside the viewer membership scope', async () => {
      prisma.circlePost.findMany.mockResolvedValue([]);
      prisma.circlePost.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });

      await service.getFeed('viewer-1', {
        circleId: 'circle-1',
        city: '上海',
      });

      expect(prisma.circlePost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // 圈子筛选与成员范围合并进同一个 link 条件（杜绝跨圈泄露）。
            circleLinks: {
              some: {
                circle: {
                  deleted: false,
                  members: {
                    some: { userID: 'viewer-1', status: 'ACTIVE' },
                  },
                },
                circleID: 'circle-1',
              },
            },
            cities: { has: '上海' },
          }),
        }),
      );
    });

    it('keeps saved multi-circle and multi-city filters inside the viewer membership scope', async () => {
      prisma.circlePost.findMany.mockResolvedValue([]);
      prisma.circlePost.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });

      await service.getFeed('viewer-1', {
        circleIds: 'circle-1,circle-2',
        cities: '上海,杭州',
      } as any);

      expect(prisma.circlePost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleLinks: {
              some: {
                circle: {
                  deleted: false,
                  members: {
                    some: { userID: 'viewer-1', status: 'ACTIVE' },
                  },
                },
                circleID: { in: ['circle-1', 'circle-2'] },
              },
            },
            cities: { hasSome: ['上海', '杭州'] },
          }),
        }),
      );
    });

    it('caps comma-separated filters at 50 items to bound the IN clause', async () => {
      prisma.circlePost.findMany.mockResolvedValue([]);
      prisma.circlePost.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });

      const manyIds = Array.from({ length: 60 }, (_, i) => `c${i}`).join(',');

      await service.getFeed('viewer-1', { circleIds: manyIds } as any);

      const where = prisma.circlePost.findMany.mock.calls[0][0].where;
      expect(where.circleLinks.some.circleID.in).toHaveLength(50);
    });

    it('includes the post author display icons in feed DTOs', async () => {
      const displayIcons = [
        {
          id: 'vip-5',
          type: 'SYSTEM',
          title: 'VIP5',
          imageUrl: null,
          fallbackIconName: null,
          systemKey: 'VIP',
          systemVariant: 'VIP5',
          sortOrder: 0,
        },
      ];
      prisma.circlePost.findMany.mockResolvedValue([
        {
          id: 'post-1',
          content: 'hello',
          images: [],
          tags: [],
          city: null,
          isHorn: false,
          noteID: null,
          vipRestriction: null,
          creditRestriction: null,
          fancyRestriction: false,
          viewCount: 0,
          signupCount: 0,
          signupVipRestriction: null,
          signupCreditRestriction: null,
          signupFancyRestriction: false,
          createdAt: new Date('2026-06-29T00:00:00.000Z'),
          author: {
            id: 'author-1',
            nickname: 'Author',
            avatarUrl: null,
            avatarFrame: null,
            accountId: '1001',
          },
          circle: { id: 'circle-1', name: 'Circle' },
        },
      ]);
      prisma.circlePost.count.mockResolvedValue(1);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });
      prisma.circlePostSignup.findMany.mockResolvedValue([]);
      iconService.getDisplayIconsForUsers.mockResolvedValue(
        new Map([['author-1', displayIcons]]),
      );

      const result = await service.getFeed('viewer-1', {});

      expect(iconService.getDisplayIconsForUsers).toHaveBeenCalledWith(
        expect.arrayContaining(['author-1']),
      );
      expect(result.items[0].author.displayIcons).toEqual(displayIcons);
    });

    it('keyset mode (cursor): no skip, no count(), fetches limit+1 with the tuple predicate', async () => {
      const b64url = (createdAt: Date, id: string) =>
        Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
          'base64url',
        );
      const makeRow = (id: string, createdAt: Date) => ({
        id,
        content: `c-${id}`,
        images: [],
        tags: [],
        city: null,
        isHorn: false,
        noteID: null,
        vipRestriction: null,
        creditRestriction: null,
        fancyRestriction: false,
        viewCount: 0,
        signupCount: 0,
        signupVipRestriction: null,
        signupCreditRestriction: null,
        signupFancyRestriction: false,
        createdAt,
        author: {
          id: 'author-1',
          nickname: 'A',
          avatarUrl: null,
          avatarFrame: null,
          accountId: '1001',
        },
        circle: { id: 'circle-1', name: 'Circle' },
      });
      // limit=2 → return 3 rows so the extra row signals a next page.
      prisma.circlePost.findMany.mockResolvedValue([
        makeRow('p3', new Date('2026-06-03T00:00:00.000Z')),
        makeRow('p2', new Date('2026-06-02T00:00:00.000Z')),
        makeRow('p1', new Date('2026-06-01T00:00:00.000Z')),
      ]);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });
      prisma.circlePostSignup.findMany.mockResolvedValue([]);
      iconService.getDisplayIconsForUsers.mockResolvedValue(new Map());

      const result = await service.getFeed('viewer-1', {
        limit: 2,
        cursor: b64url(new Date('2026-06-04T00:00:00.000Z'), 'p4'),
      });

      // No count() runs on the keyset path.
      expect(prisma.circlePost.count).not.toHaveBeenCalled();
      const args = prisma.circlePost.findMany.mock.calls[0][0];
      expect(args.take).toBe(3); // limit + 1
      expect(args.skip).toBeUndefined();
      // Keyset predicate is ANDed onto the membership/visibility base filter.
      expect(Array.isArray(args.where.AND)).toBe(true);

      expect(result.items).toHaveLength(2);
      expect(result.total).toBeNull();
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(
        b64url(new Date('2026-06-02T00:00:00.000Z'), 'p2'),
      );
    });

    it('rejects a malformed cursor before touching the DB', async () => {
      await expect(
        service.getFeed('viewer-1', { cursor: 'not a valid cursor' }),
      ).rejects.toThrow(/cursor/i);
      expect(prisma.circlePost.findMany).not.toHaveBeenCalled();
    });
  });

  it('rejects creating a post with a note owned by another user', async () => {
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        id: 'member-1',
        status: 'ACTIVE',
        role: 'MEMBER',
        circle: { id: 'circle-1', deleted: false, memberCanPost: true },
      },
    ]);
    prisma.note.findFirst.mockResolvedValue(null);

    await expect(
      service.createPost('user-1', {
        circleId: 'circle-1',
        content: 'hello plaza',
        noteId: 'note-1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a post with off-origin images when MinIO is configured', async () => {
    const guarded = new CirclePlazaService(
      prisma as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
      realtime as any,
      notificationService as any,
      iconService as any,
    );
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        id: 'member-1',
        status: 'ACTIVE',
        role: 'MEMBER',
        circle: { id: 'circle-1', deleted: false, memberCanPost: true },
      },
    ]);

    await expect(
      guarded.createPost('user-1', {
        circleId: 'circle-1',
        content: 'hello plaza',
        images: ['https://evil.example.com/track.gif'],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists a bounded post expiry duration when creating a plaza post', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-06-29T12:00:00Z').getTime());
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        id: 'member-1',
        status: 'ACTIVE',
        role: 'MEMBER',
        circle: { id: 'circle-1', deleted: false, memberCanPost: true },
      },
    ]);
    prisma.circlePost.create.mockResolvedValue({
      id: 'post-1',
      content: 'hello plaza',
      images: [],
      tags: [],
      city: null,
      isHorn: false,
      noteID: null,
      vipRestriction: null,
      creditRestriction: null,
      fancyRestriction: false,
      viewCount: 0,
      signupCount: 0,
      signupVipRestriction: null,
      signupCreditRestriction: null,
      signupFancyRestriction: false,
      author: {
        id: 'user-1',
        nickname: 'Host',
        avatarUrl: null,
        avatarFrame: null,
        accountId: '1001',
      },
      circle: { id: 'circle-1', name: 'Board games' },
      createdAt: new Date('2026-06-29T12:00:00Z'),
      expiresAt: new Date('2026-07-02T12:00:00Z'),
    });
    prisma.circle.update.mockResolvedValue({});

    const result = await service.createPost('user-1', {
      circleId: 'circle-1',
      content: 'hello plaza',
      expiresInHours: 72,
    });

    expect(prisma.circlePost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expiresAt: new Date('2026-07-02T12:00:00.000Z'),
        }),
      }),
    );
    expect(result.expiresAt).toBe('2026-07-02T12:00:00.000Z');
    jest.useRealTimers();
  });

  it('fans out a new-activity notification to active circle members after publishing', async () => {
    // 发帖成员校验用 include，扇出取成员用 select.userID —— 按参数分流，不依赖调用顺序。
    prisma.circleMember.findMany.mockImplementation((args: any) => {
      if (args?.select?.userID) {
        return Promise.resolve([
          { userID: 'member-2' },
          { userID: 'member-3' },
        ]);
      }
      return Promise.resolve([
        {
          circleID: 'circle-1',
          id: 'member-1',
          status: 'ACTIVE',
          role: 'MEMBER',
          circle: { id: 'circle-1', deleted: false, memberCanPost: true },
        },
      ]);
    });
    prisma.circlePost.create.mockResolvedValue({
      id: 'post-1',
      authorID: 'user-1',
      content: 'hi',
      images: [],
      tags: [],
      city: null,
      isHorn: false,
      author: {
        id: 'user-1',
        nickname: 'Host',
        avatarUrl: null,
        avatarFrame: null,
        accountId: '1001',
      },
      circle: { id: 'circle-1', name: 'Board games' },
      createdAt: new Date('2026-06-29T12:00:00Z'),
      expiresAt: new Date('2026-06-30T12:00:00Z'),
    });
    notificationService.createCirclePostPublishedNotifications.mockResolvedValue(
      [
        { toUserId: 'member-2', notification: { id: 'n2' } },
        { toUserId: 'member-3', notification: { id: 'n3' } },
      ],
    );

    await service.createPost('user-1', {
      circleId: 'circle-1',
      content: 'hi',
    });
    // 扇出是 fire-and-forget，flush 一次宏任务让它跑完再断言。
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      notificationService.createCirclePostPublishedNotifications,
    ).toHaveBeenCalledWith({
      postId: 'post-1',
      fromUserId: 'user-1',
      recipientIds: ['member-2', 'member-3'],
    });
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
      'member-2',
      { id: 'n2' },
    );
    expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
      'member-3',
      { id: 'n3' },
    );
  });

  it('excludes the author and blocked users from the publish fan-out', async () => {
    prisma.circleMember.findMany.mockImplementation((args: any) => {
      if (args?.select?.userID) {
        return Promise.resolve([
          { userID: 'member-2' },
          { userID: 'blocker-9' },
        ]);
      }
      return Promise.resolve([
        {
          circleID: 'circle-1',
          id: 'member-1',
          status: 'ACTIVE',
          role: 'MEMBER',
          circle: { id: 'circle-1', deleted: false, memberCanPost: true },
        },
      ]);
    });
    // blocker-9 与作者存在拉黑关系（对向），应被剔除。
    prisma.block.findMany.mockResolvedValue([
      { blockerID: 'blocker-9', blockedID: 'user-1' },
    ]);
    prisma.circlePost.create.mockResolvedValue({
      id: 'post-1',
      authorID: 'user-1',
      content: 'hi',
      images: [],
      tags: [],
      city: null,
      isHorn: false,
      author: {
        id: 'user-1',
        nickname: 'Host',
        avatarUrl: null,
        avatarFrame: null,
        accountId: '1001',
      },
      circle: { id: 'circle-1', name: 'Board games' },
      createdAt: new Date('2026-06-29T12:00:00Z'),
      expiresAt: new Date('2026-06-30T12:00:00Z'),
    });

    await service.createPost('user-1', {
      circleId: 'circle-1',
      content: 'hi',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      notificationService.createCirclePostPublishedNotifications,
    ).toHaveBeenCalledWith({
      postId: 'post-1',
      fromUserId: 'user-1',
      recipientIds: ['member-2'],
    });
  });

  it('defaults to a 24h expiry when expiresInHours is omitted', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-06-29T12:00:00Z').getTime());
    prisma.circleMember.findMany.mockResolvedValue([
      {
        circleID: 'circle-1',
        id: 'member-1',
        status: 'ACTIVE',
        role: 'MEMBER',
        circle: { id: 'circle-1', deleted: false, memberCanPost: true },
      },
    ]);
    prisma.circlePost.create.mockResolvedValue({
      id: 'post-1',
      content: 'hi',
      images: [],
      tags: [],
      city: null,
      isHorn: false,
      noteID: null,
      vipRestriction: null,
      creditRestriction: null,
      fancyRestriction: false,
      viewCount: 0,
      signupCount: 0,
      signupVipRestriction: null,
      signupCreditRestriction: null,
      signupFancyRestriction: false,
      author: {
        id: 'user-1',
        nickname: 'Host',
        avatarUrl: null,
        avatarFrame: null,
        accountId: '1001',
      },
      circle: { id: 'circle-1', name: 'Board games' },
      createdAt: new Date('2026-06-29T12:00:00Z'),
      expiresAt: new Date('2026-06-30T12:00:00Z'),
    });
    prisma.circle.update.mockResolvedValue({});

    await service.createPost('user-1', {
      circleId: 'circle-1',
      content: 'hi',
    });

    expect(prisma.circlePost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // 24h after the mocked "now"
          expiresAt: new Date('2026-06-30T12:00:00.000Z'),
        }),
      }),
    );
    jest.useRealTimers();
  });

  describe('signupForPost', () => {
    const activePost = {
      id: 'post-1',
      authorID: 'author-1',
      circleID: 'circle-1',
      content: 'hi',
      signupVipRestriction: null,
      signupCreditRestriction: null,
      signupFancyRestriction: false,
    };
    const eligibleViewer = {
      vipLevel: 9,
      creditScore: 100,
      fancyNumber: true,
    };

    it('creates signup, increments count, and refreshes only the author badge', async () => {
      const notification = {
        id: 'notification-1',
        type: 'CIRCLE_POST_SIGNUP_CREATED',
      };
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(eligibleViewer);
      prisma.circlePostSignup.create.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.update.mockResolvedValue({ signupCount: 3 });
      notificationService.createCirclePostSignupNotification.mockResolvedValue(
        notification,
      );

      const result = await service.signupForPost('user-2', 'post-1');

      expect(result).toEqual({ signed: true, signupCount: 3 });
      expect(realtime.broadcastSignupUnread).toHaveBeenCalledTimes(1);
      expect(realtime.broadcastSignupUnread).toHaveBeenCalledWith('author-1');
      expect(
        notificationService.createCirclePostSignupNotification,
      ).toHaveBeenCalledWith({
        toUserId: 'author-1',
        fromUserId: 'user-2',
        postId: 'post-1',
      });
      expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
        'author-1',
        notification,
      );
    });

    it('is idempotent when already signed up', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      prisma.circlePostSignup.findUnique.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.findUnique.mockResolvedValue({ signupCount: 5 });

      const result = await service.signupForPost('user-2', 'post-1');

      expect(result).toEqual({ signed: true, signupCount: 5 });
      expect(prisma.circlePostSignup.create).not.toHaveBeenCalled();
      expect(realtime.broadcastSignupUnread).not.toHaveBeenCalled();
    });

    it('is idempotent when concurrent signup hits the P2002 unique constraint', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      // Pre-check passes: the racing request has not committed yet.
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(eligibleViewer);
      // Inside the transaction the unique constraint fires for the loser.
      prisma.circlePostSignup.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      // Re-read of the current count after the constraint violation.
      prisma.circlePost.findUnique.mockResolvedValue({ signupCount: 7 });

      const result = await service.signupForPost('user-2', 'post-1');

      expect(result).toEqual({ signed: true, signupCount: 7 });
      expect(prisma.circlePost.findUnique).toHaveBeenCalledWith({
        where: { id: 'post-1' },
        select: { signupCount: true },
      });
    });

    it('rejects an author signing up to their own post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);

      await expect(service.signupForPost('author-1', 'post-1')).rejects.toThrow(
        ForbiddenException,
      );

      expect(prisma.circlePostSignup.create).not.toHaveBeenCalled();
      expect(realtime.broadcastSignupUnread).not.toHaveBeenCalled();
    });
  });

  describe('signup management', () => {
    it('lists my posts with per-post unread signup counts', async () => {
      prisma.circlePost.findMany.mockResolvedValue([
        {
          id: 'post-1',
          circleID: 'circle-1',
          content: 'Hiking this weekend, who is in?',
          images: ['img-1'],
          signupCount: 5,
          status: 'ACTIVE',
          createdAt: new Date('2026-06-06T00:00:00Z'),
        },
      ]);
      prisma.circlePost.count.mockResolvedValue(1);
      prisma.circlePostSignup.groupBy.mockResolvedValue([
        { postID: 'post-1', _count: { _all: 2 } },
      ]);

      const result = await service.listMyPosts('author-1', 1);

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'post-1',
          signupCount: 5,
          unreadSignupCount: 2,
          firstImage: 'img-1',
        }),
      );
      expect(result.total).toBe(1);
    });

    it('keeps ended posts that still need collaboration recognition in signup management', async () => {
      prisma.circlePost.findMany.mockResolvedValue([]);
      prisma.circlePost.count.mockResolvedValue(0);
      prisma.circlePostSignup.groupBy.mockResolvedValue([]);

      await service.listMyPosts('author-1', 1);

      const expectedWhere = {
        authorID: 'author-1',
        OR: [
          { status: 'ACTIVE' },
          { status: 'ENDED', collaborationRecognizedAt: null },
        ],
      };
      expect(prisma.circlePost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(prisma.circlePost.count).toHaveBeenCalledWith({
        where: expectedWhere,
      });
    });

    it('falls back to createdAt+24h for a legacy post with a null expiresAt', async () => {
      prisma.circlePost.findMany.mockResolvedValue([
        {
          id: 'post-legacy',
          circleID: 'circle-1',
          content: 'legacy',
          images: [],
          signupCount: 0,
          status: 'ACTIVE',
          createdAt: new Date('2026-06-01T00:00:00Z'),
          expiresAt: null,
        },
      ]);
      prisma.circlePost.count.mockResolvedValue(1);
      prisma.circlePostSignup.groupBy.mockResolvedValue([]);

      const result = await service.listMyPosts('author-1', 1);

      // null expiresAt → createdAt + 24h, surfaced as an ISO string (never null)
      expect(result.items[0].expiresAt).toBe('2026-06-02T00:00:00.000Z');
    });

    it('returns signers with OpenIM ids for my own post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        status: 'ACTIVE',
        collaborationRecognizedAt: null,
      });
      const displayIcons = [
        {
          id: 'vip-5',
          type: 'SYSTEM',
          title: 'VIP5',
          imageUrl: null,
          fallbackIconName: null,
          systemKey: 'VIP',
          systemVariant: 'VIP5',
          sortOrder: 0,
        },
      ];
      prisma.circlePostSignup.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-06-06T00:00:00Z'),
          seenByAuthor: false,
          user: {
            id: '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547',
            nickname: 'meiguici',
            avatarUrl: null,
            accountId: '123',
          },
        },
      ]);
      iconService.getDisplayIconsForUsers.mockResolvedValue(
        new Map([['0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547', displayIcons]]),
      );

      const result = await service.getMyPostSignups('author-1', 'post-1');

      expect(iconService.getDisplayIconsForUsers).toHaveBeenCalledWith(
        expect.arrayContaining(['0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547']),
      );
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          userId: '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547',
          imUserId: '0a9ad3d6ef1d47bd9cbccda1cee57547',
          nickname: 'meiguici',
          seen: false,
          displayIcons,
          recognized: false,
        }),
      );
      expect(result.recognitionOpen).toBe(false);
    });

    it('opens recognition selection for ended unrecognized posts and marks already recognized signers', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        status: 'ENDED',
        collaborationRecognizedAt: null,
      });
      prisma.circlePostSignup.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-06-06T00:00:00Z'),
          seenByAuthor: true,
          user: {
            id: '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547',
            nickname: 'meiguici',
            avatarUrl: null,
            accountId: '123',
          },
        },
      ]);
      prisma.collaborationRecognition.findMany.mockResolvedValue([
        { recipientID: '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547' },
      ]);

      const result = await service.getMyPostSignups('author-1', 'post-1');

      expect(result.recognitionOpen).toBe(true);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          userId: '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547',
          recognized: true,
        }),
      );
    });

    it('rejects reading signers of a post the caller does not own', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(null);

      await expect(
        service.getMyPostSignups('intruder', 'post-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('marks signups seen and refreshes the author badge', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({ id: 'post-1' });
      prisma.circlePostSignup.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.markPostSignupsSeen('author-1', 'post-1');

      expect(result).toEqual({ count: 2 });
      expect(prisma.circlePostSignup.updateMany).toHaveBeenCalledWith({
        where: { postID: 'post-1', seenByAuthor: false },
        data: { seenByAuthor: true, seenAt: expect.any(Date) },
      });
      expect(realtime.broadcastSignupUnread).toHaveBeenCalledWith('author-1');
    });

    it('counts unread signups on ended posts that still need collaboration recognition', async () => {
      prisma.circlePostSignup.count.mockResolvedValue(2);

      const result = await service.getMySignupsUnreadCount('author-1');

      expect(result).toEqual({ count: 2 });
      expect(prisma.circlePostSignup.count).toHaveBeenCalledWith({
        where: {
          seenByAuthor: false,
          post: {
            authorID: 'author-1',
            OR: [
              { status: 'ACTIVE' },
              { status: 'ENDED', collaborationRecognizedAt: null },
            ],
          },
        },
      });
    });

    it('submits up to three collaboration recognitions for signed-up users', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
        circleID: 'circle-1',
        circleLinks: [{ circleID: 'circle-1' }],
      });
      prisma.circlePostSignup.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      prisma.circleMember.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.circlePost.updateMany.mockResolvedValue({ count: 1 });
      prisma.collaborationRecognition.createMany.mockResolvedValue({
        count: 2,
      });
      prisma.userLike.findMany.mockResolvedValue([]);
      prisma.userLike.createMany.mockResolvedValue({ count: 2 });
      prisma.user.updateMany.mockResolvedValue({ count: 2 });
      notificationService.createCollaborationRecognitionNotification.mockImplementation(
        ({ toUserId }: { toUserId: string }) =>
          Promise.resolve({ id: `notif-${toUserId}`, type: 'x' }),
      );

      const result = await service.recognizePostCollaborators(
        'author-1',
        'post-1',
        ['user-2', 'user-3', 'user-2'],
      );

      expect(result).toEqual({
        count: 2,
        recognizedUserIds: ['user-2', 'user-3'],
      });
      expect(prisma.circlePost.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'post-1',
          authorID: 'author-1',
          status: { in: ['ACTIVE', 'ENDED'] },
        },
        select: {
          id: true,
          authorID: true,
          circleID: true,
          circleLinks: { select: { circleID: true } },
        },
      });
      expect(prisma.circleMember.findMany).toHaveBeenCalledWith({
        where: {
          circleID: { in: ['circle-1'] },
          status: 'ACTIVE',
          userID: { in: ['user-2', 'user-3'] },
        },
        select: { userID: true },
      });
      expect(prisma.circlePostSignup.count).not.toHaveBeenCalled();
      expect(prisma.circlePost.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'post-1',
          authorID: 'author-1',
          collaborationRecognizedAt: null,
        },
        data: { collaborationRecognizedAt: expect.any(Date) },
      });
      expect(prisma.collaborationRecognition.createMany).toHaveBeenCalledWith({
        data: [
          {
            recipientID: 'user-2',
            recognizerID: 'author-1',
            circlePostID: 'post-1',
          },
          {
            recipientID: 'user-3',
            recognizerID: 'author-1',
            circlePostID: 'post-1',
          },
        ],
      });
      expect(prisma.userLike.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            fromUserID: 'author-1',
            toUserID: 'user-2',
          }),
          expect.objectContaining({
            fromUserID: 'author-1',
            toUserID: 'user-3',
          }),
        ],
        skipDuplicates: true,
      });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['user-2', 'user-3'] } },
        data: { receivedLikeCount: { increment: 1 } },
      });
      // each recipient's cached icon eligibility is refreshed so a newly earned
      // TOP_COLLABORATOR badge shows up without waiting for the 30s cache TTL
      expect(iconService.invalidateDisplayIconCacheFor).toHaveBeenCalledWith(
        'user-2',
      );
      expect(iconService.invalidateDisplayIconCacheFor).toHaveBeenCalledWith(
        'user-3',
      );
      expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(
        'user-2',
      );
      expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(
        'user-3',
      );
      // each recognized collaborator is notified (fromUser = author), and the
      // resulting notification is pushed over realtime to that recipient
      expect(
        notificationService.createCollaborationRecognitionNotification,
      ).toHaveBeenCalledWith({
        toUserId: 'user-2',
        fromUserId: 'author-1',
        postId: 'post-1',
      });
      expect(
        notificationService.createCollaborationRecognitionNotification,
      ).toHaveBeenCalledWith({
        toUserId: 'user-3',
        fromUserId: 'author-1',
        postId: 'post-1',
      });
      expect(
        notificationService.createCollaborationRecognitionNotification,
      ).toHaveBeenCalledTimes(2);
      expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
        'user-2',
        { id: 'notif-user-2', type: 'x' },
      );
      expect(realtime.broadcastNotificationCreated).toHaveBeenCalledWith(
        'user-3',
        { id: 'notif-user-3', type: 'x' },
      );
    });

    it('does not block the recognition response on profile realtime refresh', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
        circleID: 'circle-1',
      });
      prisma.circlePostSignup.findMany.mockResolvedValue([
        { userID: 'user-2' },
      ]);
      prisma.circleMember.findMany.mockResolvedValue([{ userID: 'user-2' }]);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.circlePost.updateMany.mockResolvedValue({ count: 1 });
      prisma.collaborationRecognition.createMany.mockResolvedValue({
        count: 1,
      });
      prisma.userLike.findMany.mockResolvedValue([]);
      prisma.userLike.createMany.mockResolvedValue({ count: 1 });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      realtime.broadcastUserProfileSummary.mockImplementationOnce(
        () => new Promise(() => undefined),
      );

      const result = await Promise.race([
        service.recognizePostCollaborators('author-1', 'post-1', ['user-2']),
        new Promise((resolve) => setTimeout(() => resolve('timed-out'), 25)),
      ]);

      expect(result).toEqual({
        count: 1,
        recognizedUserIds: ['user-2'],
      });
      expect(iconService.invalidateDisplayIconCacheFor).toHaveBeenCalledWith(
        'user-2',
      );
      expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(
        'user-2',
      );
    });

    it('rejects collaboration recognition when more than three users are selected', async () => {
      await expect(
        service.recognizePostCollaborators('author-1', 'post-1', [
          'user-2',
          'user-3',
          'user-4',
          'user-5',
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.circlePost.findFirst).not.toHaveBeenCalled();
      expect(prisma.collaborationRecognition.createMany).not.toHaveBeenCalled();
    });

    it('rejects collaboration recognition for users who did not sign up', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
      });
      prisma.circlePostSignup.count.mockResolvedValue(3);
      prisma.circlePostSignup.findMany.mockResolvedValue([
        { userID: 'user-2' },
      ]);

      await expect(
        service.recognizePostCollaborators('author-1', 'post-1', [
          'user-2',
          'user-9',
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.circlePost.updateMany).not.toHaveBeenCalled();
      expect(prisma.collaborationRecognition.createMany).not.toHaveBeenCalled();
    });

    it('rejects duplicate collaboration recognition submission for the same post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
        circleID: 'circle-1',
      });
      prisma.circlePostSignup.count.mockResolvedValue(3);
      prisma.circlePostSignup.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      prisma.circleMember.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.circlePost.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.recognizePostCollaborators('author-1', 'post-1', [
          'user-2',
          'user-3',
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.collaborationRecognition.createMany).not.toHaveBeenCalled();
    });

    it('rejects recognition for a signed-up user who is no longer an active circle member', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
        circleID: 'circle-1',
      });
      prisma.circlePostSignup.count.mockResolvedValue(3);
      prisma.circlePostSignup.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      // user-3 signed up but has since left the circle
      prisma.circleMember.findMany.mockResolvedValue([{ userID: 'user-2' }]);
      prisma.block.findFirst.mockResolvedValue(null);

      await expect(
        service.recognizePostCollaborators('author-1', 'post-1', [
          'user-2',
          'user-3',
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.circlePost.updateMany).not.toHaveBeenCalled();
      expect(prisma.collaborationRecognition.createMany).not.toHaveBeenCalled();
    });

    it('rejects recognition for a user in a block relationship with the author', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
        circleID: 'circle-1',
      });
      prisma.circlePostSignup.count.mockResolvedValue(3);
      prisma.circlePostSignup.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      prisma.circleMember.findMany.mockResolvedValue([
        { userID: 'user-2' },
        { userID: 'user-3' },
      ]);
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });

      await expect(
        service.recognizePostCollaborators('author-1', 'post-1', [
          'user-2',
          'user-3',
        ]),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.circlePost.updateMany).not.toHaveBeenCalled();
      expect(prisma.collaborationRecognition.createMany).not.toHaveBeenCalled();
    });

    it('bulk-ends an expired batch under an advisory lock and notifies each author', async () => {
      const now = new Date('2026-06-29T12:00:00Z');
      prisma.$executeRaw.mockResolvedValue(1);
      prisma.circlePost.findMany.mockResolvedValue([
        { id: 'post-1', authorID: 'author-1' },
        { id: 'post-2', authorID: 'author-2' },
      ]);
      prisma.circlePost.updateMany.mockResolvedValue({ count: 2 });
      notificationService.createCirclePostAutoEndedNotification.mockResolvedValue(
        null,
      );

      const result = await service.sweepExpiredPosts(now);

      expect(result).toEqual({ count: 2 });
      // sweep is serialized by a transaction-scoped advisory lock
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.circlePost.findMany).toHaveBeenCalledWith({
        where: {
          status: 'ACTIVE',
          OR: [
            { expiresAt: { lte: now } },
            {
              expiresAt: null,
              createdAt: { lte: new Date('2026-06-28T12:00:00.000Z') },
            },
          ],
        },
        select: { id: true, authorID: true },
        orderBy: [
          { expiresAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
        ],
        take: 100,
      });
      // one bulk write for the whole batch, not one per post
      expect(prisma.circlePost.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.circlePost.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['post-1', 'post-2'] }, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now },
      });
      expect(
        notificationService.createCirclePostAutoEndedNotification,
      ).toHaveBeenCalledWith({ toUserId: 'author-1', postId: 'post-1' });
      expect(
        notificationService.createCirclePostAutoEndedNotification,
      ).toHaveBeenCalledWith({ toUserId: 'author-2', postId: 'post-2' });
    });

    it('returns zero and skips the bulk write when nothing is expired', async () => {
      const now = new Date('2026-06-29T12:00:00Z');
      prisma.$executeRaw.mockResolvedValue(1);
      prisma.circlePost.findMany.mockResolvedValue([]);

      const result = await service.sweepExpiredPosts(now);

      expect(result).toEqual({ count: 0 });
      expect(prisma.circlePost.updateMany).not.toHaveBeenCalled();
      expect(
        notificationService.createCirclePostAutoEndedNotification,
      ).not.toHaveBeenCalled();
    });

    it('continues notifying the rest of the batch when one notification throws', async () => {
      const now = new Date('2026-06-29T12:00:00Z');
      prisma.$executeRaw.mockResolvedValue(1);
      prisma.circlePost.findMany.mockResolvedValue([
        { id: 'post-1', authorID: 'author-1' },
        { id: 'post-2', authorID: 'author-2' },
      ]);
      prisma.circlePost.updateMany.mockResolvedValue({ count: 2 });
      notificationService.createCirclePostAutoEndedNotification
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(null);

      const result = await service.sweepExpiredPosts(now);

      // the rows were still ended; a failed notification does not roll them back
      expect(result).toEqual({ count: 2 });
      expect(
        notificationService.createCirclePostAutoEndedNotification,
      ).toHaveBeenCalledTimes(2);
    });
  });

  describe('signup eligibility', () => {
    const restrictedPost = {
      id: 'post-1',
      authorID: 'author-1',
      circleID: 'circle-1',
      signupVipRestriction: 3,
      signupCreditRestriction: null,
      signupFancyRestriction: false,
    };

    it('rejects signup when viewer VIP below signup restriction', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(restrictedPost);
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 1,
        creditScore: 100,
        fancyNumber: false,
      });

      await expect(service.signupForPost('user-2', 'post-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.circlePostSignup.create).not.toHaveBeenCalled();
    });

    it('allows signup when viewer meets restriction', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(restrictedPost);
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 5,
        creditScore: 100,
        fancyNumber: false,
      });
      prisma.circlePostSignup.create.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.update.mockResolvedValue({ signupCount: 1 });

      const result = await service.signupForPost('user-2', 'post-1');
      expect(result).toEqual({ signed: true, signupCount: 1 });
    });
  });

  describe('cancelSignup', () => {
    it('removes signup and decrements count', async () => {
      prisma.circlePostSignup.findUnique.mockResolvedValue({ id: 's-1' });
      prisma.circlePostSignup.delete.mockResolvedValue({});
      prisma.circlePost.update.mockResolvedValue({ signupCount: 2 });

      const result = await service.cancelSignup('user-2', 'post-1');

      expect(result).toEqual({ signed: false, signupCount: 2 });
    });

    it('is a no-op when not signed up', async () => {
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.circlePost.findUnique.mockResolvedValue({ signupCount: 4 });

      const result = await service.cancelSignup('user-2', 'post-1');

      expect(result).toEqual({ signed: false, signupCount: 4 });
      expect(prisma.circlePostSignup.delete).not.toHaveBeenCalled();
    });
  });

  describe('getPostSignups', () => {
    it('maps signups to public user shape', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({ id: 'post-1' });
      prisma.circlePostSignup.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-06-05T00:00:00Z'),
          user: { id: 'u1', nickname: 'A', avatarUrl: null, accountId: '100' },
        },
      ]);

      const result = await service.getPostSignups('author-1', 'post-1');

      expect(result.items).toEqual([
        {
          id: 'u1',
          nickname: 'A',
          avatarUrl: null,
          accountId: '100',
          signedAt: '2026-06-05T00:00:00.000Z',
        },
      ]);
    });

    it('rejects reading signups for a post the caller does not own', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(null);

      await expect(service.getPostSignups('user-2', 'post-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.circlePostSignup.findMany).not.toHaveBeenCalled();
    });
  });

  describe('signedByMe in DTO', () => {
    it('getPost returns signedByMe=true when viewer has signed up', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        content: 'x',
        images: [],
        tags: [],
        city: null,
        isHorn: false,
        noteID: null,
        vipRestriction: null,
        creditRestriction: null,
        fancyRestriction: false,
        signupVipRestriction: null,
        signupCreditRestriction: null,
        signupFancyRestriction: false,
        viewCount: 0,
        signupCount: 2,
        createdAt: new Date('2026-06-05T00:00:00Z'),
        author: {
          id: 'a',
          nickname: 'A',
          avatarUrl: null,
          avatarFrame: null,
          accountId: '1',
        },
        circle: { id: 'c', name: 'C' },
      });
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });
      prisma.circlePostSignup.findUnique.mockResolvedValue({ id: 's-1' });

      const dto = await service.getPost('viewer-1', 'post-1');

      expect(dto.signupCount).toBe(2);
      expect(dto.signedByMe).toBe(true);
    });

    it('getPost gates visibility on circle membership (no read-by-id leak)', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: 0,
        creditScore: 100,
        fancyNumber: false,
      });

      await expect(service.getPost('viewer-1', 'post-1')).rejects.toThrow(
        NotFoundException,
      );
      // 详情查询必须带 viewer 的成员范围 link 条件（与 feed 一致）。
      expect(prisma.circlePost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleLinks: {
              some: {
                circle: {
                  deleted: false,
                  members: {
                    some: { userID: 'viewer-1', status: 'ACTIVE' },
                  },
                },
              },
            },
          }),
        }),
      );
    });
  });

  describe('deletePost', () => {
    const ownPost = {
      id: 'post-1',
      authorID: 'author-1',
      circleID: 'circle-1',
      status: 'ACTIVE',
    };

    it('decrements postCount for every linked circle exactly once', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(ownPost);
      prisma.circlePostCircle.findMany.mockResolvedValue([
        { circleID: 'circle-1' },
        { circleID: 'circle-2' },
      ]);
      prisma.circlePost.updateMany.mockResolvedValue({ count: 1 });

      await service.deletePost('author-1', 'post-1');

      expect(prisma.circlePost.updateMany).toHaveBeenCalledWith({
        where: { id: 'post-1', status: 'ACTIVE' },
        data: { status: 'DELETED' },
      });
      expect(prisma.circle.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['circle-1', 'circle-2'] } },
        data: { postCount: { decrement: 1 } },
      });
    });

    it('does not decrement postCount when the delete lost the race (already deleted)', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(ownPost);
      prisma.circlePostCircle.findMany.mockResolvedValue([
        { circleID: 'circle-1' },
      ]);
      // A concurrent delete already flipped the row → this claim matches 0 rows.
      prisma.circlePost.updateMany.mockResolvedValue({ count: 0 });

      await service.deletePost('author-1', 'post-1');

      expect(prisma.circle.updateMany).not.toHaveBeenCalled();
    });

    it('rejects deleting a post the caller does not own', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        ...ownPost,
        authorID: 'someone-else',
      });

      await expect(service.deletePost('author-1', 'post-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.circlePost.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('reportPost', () => {
    it('records a report for another user post (idempotent upsert, trims reason)', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
      });
      prisma.circlePostReport.upsert.mockResolvedValue({});

      const result = await service.reportPost(
        'reporter-2',
        'post-1',
        '  spam  ',
      );

      expect(result).toEqual({ reported: true });
      expect(prisma.circlePostReport.upsert).toHaveBeenCalledWith({
        where: {
          postID_reporterID: { postID: 'post-1', reporterID: 'reporter-2' },
        },
        create: {
          postID: 'post-1',
          reporterID: 'reporter-2',
          reason: 'spam',
        },
        update: { reason: 'spam' },
      });
    });

    it('stores null when no reason is given', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
      });
      prisma.circlePostReport.upsert.mockResolvedValue({});

      await service.reportPost('reporter-2', 'post-1');

      expect(prisma.circlePostReport.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            postID: 'post-1',
            reporterID: 'reporter-2',
            reason: null,
          },
        }),
      );
    });

    it('rejects reporting your own post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({
        id: 'post-1',
        authorID: 'author-1',
      });
      await expect(service.reportPost('author-1', 'post-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.circlePostReport.upsert).not.toHaveBeenCalled();
    });

    it('rejects reporting a missing post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(null);
      await expect(service.reportPost('reporter-2', 'missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.circlePostReport.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getPost visibility', () => {
    it('throws NotCircleMember with circle details when the viewer is not a member but the post exists', async () => {
      // 1st findFirst = 成员可见性(miss)；2nd findFirst = 去成员范围的存在性检查(命中)。
      prisma.circlePost.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          circle: { id: 'circle-1', name: 'Board games' },
        });
      prisma.user.findUnique.mockResolvedValue({
        vipLevel: null,
        creditScore: null,
        fancyNumber: false,
      });

      expect.assertions(3);
      try {
        await service.getPost('outsider', 'post-1');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const res = (err as ForbiddenException).getResponse() as {
          errorCode?: string;
          details?: unknown;
        };
        expect(res.errorCode).toBe('PLAZA_NOT_CIRCLE_MEMBER');
        expect(res.details).toEqual({
          circleId: 'circle-1',
          circleName: 'Board games',
        });
      }
    });

    it('throws PostNotFound when the post does not exist at all', async () => {
      prisma.circlePost.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getPost('u1', 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
