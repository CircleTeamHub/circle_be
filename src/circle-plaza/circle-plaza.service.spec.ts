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
});
