import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CirclePlazaService } from './circle-plaza.service';

describe('CirclePlazaService', () => {
  let service: CirclePlazaService;

  const prisma = {
    circleMember: {
      findUnique: jest.fn(),
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
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  const realtime = {
    broadcastSignupUnread: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CirclePlazaService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();

    service = module.get(CirclePlazaService);
  });

  it('rejects creating a post with a note owned by another user', async () => {
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      status: 'ACTIVE',
      role: 'MEMBER',
      circle: { id: 'circle-1', deleted: false, memberCanPost: true },
    });
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
    );
    prisma.circleMember.findUnique.mockResolvedValue({
      id: 'member-1',
      status: 'ACTIVE',
      role: 'MEMBER',
      circle: { id: 'circle-1', deleted: false, memberCanPost: true },
    });

    await expect(
      guarded.createPost('user-1', {
        circleId: 'circle-1',
        content: 'hello plaza',
        images: ['https://evil.example.com/track.gif'],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(eligibleViewer);
      prisma.circlePostSignup.create.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.update.mockResolvedValue({ signupCount: 3 });

      const result = await service.signupForPost('user-2', 'post-1');

      expect(result).toEqual({ signed: true, signupCount: 3 });
      // Signup no longer writes notification rows; the management view reads
      // CirclePostSignup directly. Only the author's badge refreshes.
      expect(realtime.broadcastSignupUnread).toHaveBeenCalledTimes(1);
      expect(realtime.broadcastSignupUnread).toHaveBeenCalledWith('author-1');
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

    it('returns signers with OpenIM ids for my own post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue({ id: 'post-1' });
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

      const result = await service.getMyPostSignups('author-1', 'post-1');

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          userId: '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547',
          imUserId: '0a9ad3d6ef1d47bd9cbccda1cee57547',
          nickname: 'meiguici',
          seen: false,
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
  });
});
