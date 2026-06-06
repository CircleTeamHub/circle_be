import { BadRequestException } from '@nestjs/common';
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
    },
    circleActivity: {
      create: jest.fn(),
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
    broadcastCircleUnreadCount: jest.fn(),
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
    };

    it('creates signup, increments count, and emits two activities', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.circlePostSignup.create.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.update.mockResolvedValue({ signupCount: 3 });
      prisma.circleActivity.create.mockResolvedValue({});

      const result = await service.signupForPost('user-2', 'post-1');

      expect(result).toEqual({ signed: true, signupCount: 3 });
      expect(prisma.circleActivity.create).toHaveBeenCalledTimes(2);
      expect(realtime.broadcastCircleUnreadCount).toHaveBeenCalledWith(
        'user-2',
      );
      expect(realtime.broadcastCircleUnreadCount).toHaveBeenCalledWith(
        'author-1',
      );
    });

    it('is idempotent when already signed up', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      prisma.circlePostSignup.findUnique.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.findUnique.mockResolvedValue({ signupCount: 5 });

      const result = await service.signupForPost('user-2', 'post-1');

      expect(result).toEqual({ signed: true, signupCount: 5 });
      expect(prisma.circlePostSignup.create).not.toHaveBeenCalled();
      expect(prisma.circleActivity.create).not.toHaveBeenCalled();
    });

    it('is idempotent when concurrent signup hits the P2002 unique constraint', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      // Pre-check passes: the racing request has not committed yet.
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
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

    it('emits only CONFIRMED when author signs up to own post', async () => {
      prisma.circlePost.findFirst.mockResolvedValue(activePost);
      prisma.circlePostSignup.findUnique.mockResolvedValue(null);
      prisma.circlePostSignup.create.mockResolvedValue({ id: 's-1' });
      prisma.circlePost.update.mockResolvedValue({ signupCount: 1 });
      prisma.circleActivity.create.mockResolvedValue({});

      await service.signupForPost('author-1', 'post-1');

      expect(prisma.circleActivity.create).toHaveBeenCalledTimes(1);
      expect(prisma.circleActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'POST_SIGNUP_CONFIRMED' }),
        }),
      );
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
      prisma.circlePostSignup.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-06-05T00:00:00Z'),
          user: { id: 'u1', nickname: 'A', avatarUrl: null, accountId: '100' },
        },
      ]);

      const result = await service.getPostSignups('post-1');

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
