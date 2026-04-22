import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { TraceService } from './trace.service';

describe('TraceService', () => {
  let service: TraceService;

  const prisma = {
    trace: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    traceLikeStat: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    traceComment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    friend: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (input: any) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [TraceService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(TraceService);
  });

  it('blocks liking a private trace that is not visible to the caller', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PRIVATE',
      likeCount: 0,
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(service.toggleLike('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejects replying to a comment from a different trace', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceComment.findFirst.mockResolvedValue({
      id: 'comment-1',
      traceID: 'trace-2',
      deleted: false,
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(
      service.addComment('viewer-1', 'trace-1', {
        content: 'reply',
        replyToId: 'comment-1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('caps embedded likes and comments in the feed query', async () => {
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.trace.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(prisma.trace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          likeStats: expect.objectContaining({
            take: expect.any(Number),
            orderBy: { updatedAt: 'desc' },
          }),
          comments: expect.objectContaining({
            take: expect.any(Number),
            orderBy: { createdAt: 'desc' },
          }),
        }),
      }),
    );
  });
});
