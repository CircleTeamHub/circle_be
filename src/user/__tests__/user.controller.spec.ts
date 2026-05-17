import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Role } from 'src/enum/roles.enum';
import { UserController } from '../user.controller';
import { UserService } from '../user.service';

describe('UserController', () => {
  let controller: UserController;
  const userService = {
    findByExactAccountId: jest.fn(),
    remove: jest.fn((id: string) => ({ id })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: userService }],
    }).compile();

    controller = module.get<UserController>(UserController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('allows authenticated users to search by exact accountId', async () => {
    userService.findByExactAccountId.mockResolvedValue({
      id: 'user-2',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });

    await expect(controller.searchUserByAccountId('jimmy')).resolves.toEqual({
      id: 'user-2',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });
    expect(userService.findByExactAccountId).toHaveBeenCalledWith('jimmy');
  });

  it('allows a user to delete their own account', () => {
    expect(
      controller.removeUser('user-1', {
        user: { userId: 'user-1', accountId: 'self', role: Role.User },
      } as any),
    ).toEqual({ id: 'user-1' });
    expect(userService.remove).toHaveBeenCalledWith('user-1');
  });

  it('allows an admin to delete another user', () => {
    expect(
      controller.removeUser('user-2', {
        user: {
          userId: 'user-1',
          accountId: 'admin',
          role: Role.Admin,
        },
      } as any),
    ).toEqual({ id: 'user-2' });
    expect(userService.remove).toHaveBeenCalledWith('user-2');
  });

  it('denies deleting another user without admin access', () => {
    expect(() =>
      controller.removeUser('user-2', {
        user: { userId: 'user-1', accountId: 'self', role: Role.User },
      } as any),
    ).toThrow(ForbiddenException);
  });
});
