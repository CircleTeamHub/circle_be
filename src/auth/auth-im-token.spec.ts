import { Logger } from '@nestjs/common';
import { AuthService, isOpenImRecordNotFoundError } from './auth.service';

describe('isOpenImRecordNotFoundError', () => {
  it('matches OpenIM 1004 / record-not-found errors', () => {
    expect(
      isOpenImRecordNotFoundError(new Error('OpenIM error: record not found')),
    ).toBe(true);
    expect(
      isOpenImRecordNotFoundError(new Error('1004 RecordNotFoundError')),
    ).toBe(true);
    expect(isOpenImRecordNotFoundError('RecordNotFound')).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isOpenImRecordNotFoundError(new Error('The operation timed out'))).toBe(
      false,
    );
    expect(isOpenImRecordNotFoundError(new Error('OpenIM HTTP 500'))).toBe(false);
    expect(isOpenImRecordNotFoundError(null)).toBe(false);
  });
});

describe('AuthService.resolveImToken retry', () => {
  // resolveImToken only touches this.openim + this.logger, so the other ctor
  // deps can be null for this focused test.
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

  const callResolve = (service: AuthService) =>
    (service as unknown as {
      resolveImToken: (userId: string, platformID?: number) => Promise<string>;
    }).resolveImToken('user-1', 1);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('retries a transient 1004 and returns the token once the user lands', async () => {
    const getUserToken = jest
      .fn()
      .mockRejectedValueOnce(new Error('OpenIM error: record not found'))
      .mockResolvedValueOnce('im-token-abc');

    await expect(callResolve(makeService(getUserToken))).resolves.toBe(
      'im-token-abc',
    );
    expect(getUserToken).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-1004 failure (keeps login fast on a hang)', async () => {
    const getUserToken = jest
      .fn()
      .mockRejectedValue(new Error('The operation timed out'));

    await expect(callResolve(makeService(getUserToken))).resolves.toBe('');
    expect(getUserToken).toHaveBeenCalledTimes(1);
  });

  it('gives up with an empty token after exhausting 1004 retries', async () => {
    const getUserToken = jest
      .fn()
      .mockRejectedValue(new Error('1004 record not found'));

    await expect(callResolve(makeService(getUserToken))).resolves.toBe('');
    expect(getUserToken).toHaveBeenCalledTimes(3);
  });
});
