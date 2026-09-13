import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { Role } from 'src/enum/roles.enum';
import { UserController } from '../user.controller';
import { UserService } from '../user.service';

describe('UserController', () => {
  let controller: UserController;
  const userService = {
    findByExactAccountId: jest.fn(),
    getAppearances: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn((id: string, status: string) => ({ id, status })),
    remove: jest.fn((id: string) => ({ id })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: userService }],
    })
      // vip-levels 端点上的 ThrottlerGuard 依赖 ThrottlerModule 的 provider（本单测未引入）；
      // 放行即可，限流本身由下方的元数据用例断言。
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<UserController>(UserController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // 管理台只用 /admin/users（脱敏 + 审计留痕）。旧的 GET/POST /user 把每个用户的
  // 邮箱/手机/微信/QQ/生日明文交给任何 role=ADMIN 的 token，不经隐私开关也不留痕，
  // 所以是删掉而不是再加一层守卫。
  it('no longer exposes the legacy admin list/create routes', () => {
    const proto = UserController.prototype as unknown as Record<
      string,
      unknown
    >;
    expect(proto.getUsers).toBeUndefined();
    expect(proto.addUser).toBeUndefined();
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

  // U5: `?accountId=a&accountId=b` 到达 handler 时是 string[]，service 里的
  // .trim() 会抛 TypeError → 500 + Sentry 噪音，而这本是客户端传错参数。
  it('rejects a non-string or overlong accountId query with 400 instead of a 500', () => {
    const req = { user: { userId: 'viewer-1' } } as never;
    expect(() =>
      controller.searchUserByAccountId(['a', 'b'] as unknown as string, req),
    ).toThrow(BadRequestException);
    expect(() => controller.searchUserByAccountId('x'.repeat(65), req)).toThrow(
      BadRequestException,
    );
    expect(userService.findByExactAccountId).not.toHaveBeenCalled();
  });

  // U3: 任何 role=ADMIN 的 token（不分 audience）都能改别人的资料且不写
  // AdminAuditLog；#121 已经因为同样的理由删掉了同级的 admin status 路由。
  it('rejects an ADMIN token patching another user profile (self only)', () => {
    expect(() =>
      controller.updateUser({ nickname: 'pwned' } as never, 'user-2', {
        user: { userId: 'user-1', accountId: 'admin', role: Role.Admin },
      } as never),
    ).toThrow(ForbiddenException);
    expect(userService.update).not.toHaveBeenCalled();
  });

  it('still lets a user patch their own profile', () => {
    userService.update.mockReturnValue({ id: 'user-1', nickname: 'me' });
    expect(
      controller.updateUser({ nickname: 'me' } as never, 'user-1', {
        user: { userId: 'user-1', accountId: 'self', role: Role.User },
      } as never),
    ).toEqual({ id: 'user-1', nickname: 'me' });
    expect(userService.update).toHaveBeenCalledWith('user-1', {
      nickname: 'me',
    });
  });

  it('allows a user to delete their own account', () => {
    expect(
      controller.removeUser('user-1', {
        user: { userId: 'user-1', accountId: 'self', role: Role.User },
      } as any),
    ).toEqual({ id: 'user-1' });
    expect(userService.remove).toHaveBeenCalledWith('user-1');
  });

  it('requires admins to use the audited admin-user status endpoint', () => {
    expect(() =>
      controller.removeUser('user-2', {
        user: {
          userId: 'user-1',
          accountId: 'admin',
          role: Role.Admin,
        },
      } as any),
    ).toThrow(ForbiddenException);
    expect(userService.remove).not.toHaveBeenCalled();
  });

  it('blocks admin self-deletes from the self-service route', () => {
    expect(() =>
      controller.removeUser('user-1', {
        user: {
          userId: 'user-1',
          accountId: 'admin',
          role: Role.Admin,
        },
      } as any),
    ).toThrow(ForbiddenException);
    expect(userService.remove).not.toHaveBeenCalled();
  });

  it('denies deleting another user without admin access', () => {
    expect(() =>
      controller.removeUser('user-2', {
        user: { userId: 'user-1', accountId: 'self', role: Role.User },
      } as any),
    ).toThrow(ForbiddenException);
  });

  it('delegates appearance batches and preserves 200 response semantics', async () => {
    userService.getAppearances.mockResolvedValue({
      alias: { vipLevel: 0, avatarFrame: null },
    });

    await expect(
      controller.getAppearances({ ids: ['alias'] }),
    ).resolves.toEqual({
      alias: { vipLevel: 0, avatarFrame: null },
    });
    expect(userService.getAppearances).toHaveBeenCalledWith(['alias']);
  });

  // 账号状态变更的用例都在 admin-user 那边：这个控制器不再暴露 status 路由，
  // 唯一入口是审计化的 PATCH /admin/users/:id/status。
});

describe('POST /user/vip-levels rate limiting', () => {
  it('guards the frontend-facing batch endpoint with ThrottlerGuard and a 30/min budget', () => {
    // 无全局 ThrottlerGuard：该端点会被前端 IM 补水/重连高频调用,必须单独限流,
    // 防止重连风暴或单个持 token 的客户端把每次最多 200 id 的 DB 查询打爆。
    const guards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        UserController.prototype.getVipLevels,
      ) ?? [];
    expect(guards).toContain(UserThrottlerGuard);
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        UserController.prototype.getVipLevels,
      ),
    ).toBe(30);
    expect(
      Reflect.getMetadata(
        'THROTTLER:TTLdefault',
        UserController.prototype.getVipLevels,
      ),
    ).toBe(60_000);
  });
});

describe('POST /user/appearances rate limiting', () => {
  it('uses the same user-scoped 30/min budget as vip-levels', () => {
    const guards =
      Reflect.getMetadata(
        GUARDS_METADATA,
        UserController.prototype.getAppearances,
      ) ?? [];
    expect(guards).toContain(UserThrottlerGuard);
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        UserController.prototype.getAppearances,
      ),
    ).toBe(30);
    expect(
      Reflect.getMetadata(
        'THROTTLER:TTLdefault',
        UserController.prototype.getAppearances,
      ),
    ).toBe(60_000);
  });
});
