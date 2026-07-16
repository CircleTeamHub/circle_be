import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * AuthService.getImToken backs GET /auth/im-token. It must reuse the same
 * resolveImToken path login uses (1004 retry included) rather than calling
 * OpenIM directly, and — unlike login, where an empty token is a tolerable
 * degradation — it must surface failure, since a caller asking only for a
 * token has nothing to fall back on.
 */
describe('AuthService.getImToken', () => {
  // getImToken only touches this.openim + this.logger, so the other ctor deps
  // can be null for this focused test (mirrors auth-im-token.spec.ts).
  function makeService(getUserToken: jest.Mock): AuthService {
    return new AuthService(
      null as any,
      null as any,
      null as any,
      { getUserToken } as any,
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
});
