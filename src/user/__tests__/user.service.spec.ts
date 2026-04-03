import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { UserService } from '../user.service';

describe('UserService', () => {
  let service: UserService;
  const prisma = {
    user: {
      delete: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UserService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('deletes a user without selecting the password hash', async () => {
    prisma.user.delete.mockResolvedValue({
      id: 'user-1',
      accountId: 'ACC_TEST1',
      username: 'tester',
      nickname: 'Tester',
      avatarUrl: null,
      status: 'ACTIVE',
      createdAt: new Date(),
    });

    await service.remove('user-1');

    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
      },
    });
  });
});
