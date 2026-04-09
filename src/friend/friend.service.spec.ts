import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { FriendService } from './friend.service';

describe('FriendService', () => {
  let service: FriendService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    block: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    friend: {
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [FriendService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<FriendService>(FriendService);
  });

  it('rejects blocking a missing user before touching friendship state', async () => {
    prisma.block.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.blockUser('user-1', 'user-2')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
