import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UserStatus } from 'src/generated/prisma';
import { AuthService } from './auth.service';

/**
 * AuthService.getImToken backs GET /auth/im-token. It must reuse the same
 * resolveImToken path login uses (1004 retry included) rather than calling
 * OpenIM directly, and — unlike login, where an empty token is a tolerable
 * degradation — it must surface failure, since a caller asking only for a
 * token has nothing to fall back on.
 */
describe('AuthService.getImToken', () => {
  // getImToken touches this.prisma（封禁校验）+ this.openim + this.logger，
  // 其余 ctor 依赖对本组测试无关，仍传 null（沿用 auth-im-token.spec.ts 的写法）。
  function makeService(
    getUserToken: jest.Mock,
    status: UserStatus | null = UserStatus.ACTIVE,
  ): AuthService {
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue(status === null ? null : { status }),
      },
    };
    return new AuthService(
      prisma as any,
      null as any,
      null as any,
      { getUserToken } as any,
      null as any,
      null as any,
      { get: () => undefined } as any,
      null as any,
      null as any,
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the minted token in the same field name login uses', async () => {
    const getUserToken = jest.fn().mockResolvedValue('im-token-abc');

    await expect(
      makeService(getUserToken).getImToken('user-1'),
    ).resolves.toEqual({
      imToken: 'im-token-abc',
    });
  });

  it('mints for the given user id and platform', async () => {
    const getUserToken = jest.fn().mockResolvedValue('im-token-abc');
    const service = makeService(getUserToken);

    await service.getImToken('user-1', 1);

    expect(getUserToken).toHaveBeenCalledWith('user-1', 1);
  });

  it('reuses the login retry path for a transient 1004', async () => {
    const getUserToken = jest
      .fn()
      .mockRejectedValueOnce(new Error('OpenIM error: record not found'))
      .mockResolvedValueOnce('im-token-abc');

    await expect(
      makeService(getUserToken).getImToken('user-1'),
    ).resolves.toEqual({
      imToken: 'im-token-abc',
    });
    expect(getUserToken).toHaveBeenCalledTimes(2);
  });

  it('surfaces 503 instead of a silently empty token when OpenIM fails', async () => {
    const getUserToken = jest
      .fn()
      .mockRejectedValue(new Error('The operation timed out'));

    await expect(
      makeService(getUserToken).getImToken('user-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('surfaces 503 when OpenIM is not configured (empty token)', async () => {
    const getUserToken = jest.fn().mockResolvedValue('');

    await expect(
      makeService(getUserToken).getImToken('user-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  // 封禁在 IM 侧唯一还起作用的关卡就在这里。JWT 会话撤销走 Redis，而 Redis 不可用时
  // 它是 fail-open 的 —— 那时被封的人 access token 依然验得过，只要调这个接口就能换到
  // 一枚新的 OpenIM token、重连 msggateway，把封禁时的强制下线原样抵消。
  // 聊天流量不经过 circle_be，放过这里就等于封禁在聊天里完全无效。
  it.each([UserStatus.BANNED, UserStatus.DELETED])(
    'refuses to mint an IM token for a %s account',
    async (status) => {
      const getUserToken = jest.fn().mockResolvedValue('im-token-abc');

      await expect(
        makeService(getUserToken, status).getImToken('user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(getUserToken).not.toHaveBeenCalled();
    },
  );

  it('refuses to mint an IM token when the user no longer exists', async () => {
    const getUserToken = jest.fn().mockResolvedValue('im-token-abc');

    await expect(
      makeService(getUserToken, null).getImToken('user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getUserToken).not.toHaveBeenCalled();
  });
});
