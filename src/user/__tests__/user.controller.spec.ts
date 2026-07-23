import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { Role } from 'src/enum/roles.enum';
import { UserController } from '../user.controller';
import { UserService } from '../user.service';

describe('UserController', () => {
  let controller: UserController;
  const userService = {
    findAll: jest.fn(),
    findByExactAccountId: jest.fn(),
    updateStatus: jest.fn((id: string, status: string) => ({ id, status })),
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

    const req = { user: { userId: 'viewer-1' } } as never;
    await expect(
      controller.searchUserByAccountId('jimmy', req),
    ).resolves.toEqual({
      id: 'user-2',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });
    // viewerId is threaded through so the service can apply profile privacy (F-01).
    expect(userService.findByExactAccountId).toHaveBeenCalledWith(
      'jimmy',
      'viewer-1',
    );
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

  it('passes admin user-list queries through to the service', () => {
    userService.findAll.mockReturnValue({ data: [], total: 0 });

    expect(
      controller.getUsers({ accountId: 'foo', status: 'BANNED' as any }),
    ).toEqual({ data: [], total: 0 });
    expect(userService.findAll).toHaveBeenCalledWith({
      accountId: 'foo',
      status: 'BANNED',
    });
  });

  // 账号状态变更的用例都在 admin-user 那边：这个控制器不再暴露 status 路由，
  // 唯一入口是审计化的 PATCH /admin/users/:id/status。
});
