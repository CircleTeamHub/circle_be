import { SessionRevocationService } from './session-revocation.service';

describe('SessionRevocationService', () => {
  const redis = {
    isEnabled: jest.fn(),
    getJson: jest.fn(),
    setJson: jest.fn(),
  };
  const svc = new SessionRevocationService(redis as never);

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setJson.mockResolvedValue(true);
  });

  describe('fail-open when Redis is disabled', () => {
    beforeEach(() => redis.isEnabled.mockReturnValue(false));

    it('isRevoked returns false and never reads Redis', async () => {
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(false);
      expect(redis.getJson).not.toHaveBeenCalled();
    });

    it('revokeUser / revokeSession are no-ops', async () => {
      await svc.revokeUser('u1');
      await svc.revokeSession('s1');
      expect(redis.setJson).not.toHaveBeenCalled();
    });
  });

  describe('with Redis enabled', () => {
    beforeEach(() => redis.isEnabled.mockReturnValue(true));

    it('flags a token whose session was revoked (single logout)', async () => {
      redis.getJson.mockImplementation((key: string) =>
        Promise.resolve(key === 'authrev:s:s1' ? 1 : null),
      );
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(true);
    });

    it('flags a token issued before the user revoke-after stamp', async () => {
      redis.getJson.mockImplementation((key: string) =>
        Promise.resolve(key === 'authrev:u:u1' ? 200 : null),
      );
      // iat 100 < revokedAfter 200 → revoked.
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(true);
    });

    it('does NOT flag a token minted at/after the revoke-after stamp', async () => {
      redis.getJson.mockImplementation((key: string) =>
        Promise.resolve(key === 'authrev:u:u1' ? 200 : null),
      );
      // A fresh re-login (iat >= revokedAfter) must survive.
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 200 }),
      ).resolves.toBe(false);
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 250 }),
      ).resolves.toBe(false);
    });

    it('does NOT flag when no markers exist', async () => {
      redis.getJson.mockResolvedValue(null);
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(false);
    });

    it('revokeUser stores an epoch under the per-user key', async () => {
      await svc.revokeUser('u1');
      expect(redis.setJson).toHaveBeenCalledWith(
        'authrev:u:u1',
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('revokeSession flags the per-session key', async () => {
      await svc.revokeSession('s1');
      expect(redis.setJson).toHaveBeenCalledWith(
        'authrev:s:s1',
        1,
        expect.any(Number),
      );
    });
  });
});
