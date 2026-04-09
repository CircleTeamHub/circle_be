import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('UserService', () => {
  let service: UserService;
  const prisma = {
    user: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('finds an active user by exact accountId without exposing admin pagination', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      accountId: 'jimmy',
      nickname: 'Jimmy',
      avatarUrl: null,
      avatarFrame: null,
      cover: null,
      email: null,
      phoneNumber: null,
      wechat: null,
      qq: null,
      whatsup: null,
      persona: null,
      helloWords: null,
      birthday: null,
      gender: 'unset',
      role: 'USER',
      status: 'ACTIVE',
      lastOnline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.findByExactAccountId(' jimmy ')).resolves.toMatchObject({
      id: 'user-1',
      accountId: 'jimmy',
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: {
          equals: 'jimmy',
          mode: 'insensitive',
        },
        status: 'ACTIVE',
      },
      select: expect.any(Object),
    });
  });

  it('returns null for empty accountId search keywords', async () => {
    await expect(service.findByExactAccountId('   ')).resolves.toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
