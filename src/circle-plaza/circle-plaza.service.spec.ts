import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
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
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
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
});
