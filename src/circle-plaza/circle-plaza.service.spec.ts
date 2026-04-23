import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
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
      update: jest.fn(),
    },
    circle: {
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CirclePlazaService,
        { provide: PrismaService, useValue: prisma },
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

  it('marks authors registered within 30 days as new users in feed', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-04-22T00:00:00.000Z').getTime());

    prisma.circlePost.findMany.mockResolvedValue([
      {
        id: 'post-1',
        content: 'hello plaza',
        images: [],
        tags: [],
        city: '上海',
        isHorn: false,
        noteID: null,
        vipRestriction: 3,
        creditRestriction: null,
        fancyRestriction: true,
        viewCount: 0,
        createdAt: new Date('2026-04-21T00:00:00.000Z'),
        author: {
          id: 'author-1',
          nickname: 'meiguici',
          avatarUrl: null,
          avatarFrame: null,
          accountId: 'jimmy',
          vipLevel: 5,
          fancyNumber: true,
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
        circle: { id: 'circle-1', name: '上海女人' },
      },
      {
        id: 'post-2',
        content: 'older user',
        images: [],
        tags: [],
        city: '上海',
        isHorn: false,
        noteID: null,
        vipRestriction: null,
        creditRestriction: null,
        fancyRestriction: false,
        viewCount: 0,
        createdAt: new Date('2026-04-20T00:00:00.000Z'),
        author: {
          id: 'author-2',
          nickname: 'old',
          avatarUrl: null,
          avatarFrame: null,
          accountId: 'old',
          vipLevel: 0,
          fancyNumber: false,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        circle: { id: 'circle-1', name: '上海女人' },
      },
    ]);
    prisma.circlePost.count.mockResolvedValue(2);
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 5,
      creditScore: 100,
      fancyNumber: true,
    });

    const feed = await service.getFeed('viewer-1', {
      city: '上海',
      page: 1,
      limit: 20,
    });

    expect(feed.items[0].author.isNewUser).toBe(true);
    expect(feed.items[0].author.vipLevel).toBe(5);
    expect(feed.items[0].author.fancyNumber).toBe(true);
    expect(feed.items[1].author.isNewUser).toBe(false);

    jest.useRealTimers();
  });
});
