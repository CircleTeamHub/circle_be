import {
  SESSION_REVOCATION_CHANNEL,
  parseSessionRevocationBroadcast,
} from './session-revocation.broadcast';
import { SessionRevocationService } from './session-revocation.service';

describe('parseSessionRevocationBroadcast', () => {
  it('accepts well-formed user and session broadcasts', () => {
    expect(
      parseSessionRevocationBroadcast(
        JSON.stringify({ kind: 'user', userId: 'u1', revokedAtMs: 42 }),
      ),
    ).toEqual({ kind: 'user', userId: 'u1', revokedAtMs: 42 });
    expect(
      parseSessionRevocationBroadcast(
        JSON.stringify({ kind: 'session', sessionId: 's1' }),
      ),
    ).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it.each([
    ['not json', 'not json'],
    ['null', 'null'],
    ['unknown kind', JSON.stringify({ kind: 'everyone' })],
    ['missing userId', JSON.stringify({ kind: 'user', revokedAtMs: 1 })],
    [
      'empty userId',
      JSON.stringify({ kind: 'user', userId: '', revokedAtMs: 1 }),
    ],
    [
      'non-numeric stamp',
      JSON.stringify({ kind: 'user', userId: 'u1', revokedAtMs: 'x' }),
    ],
    ['missing sessionId', JSON.stringify({ kind: 'session' })],
  ])('rejects %s rather than throwing', (_label, message) => {
    expect(parseSessionRevocationBroadcast(message)).toBeNull();
  });
});

describe('SessionRevocationService', () => {
  const redis = {
    isEnabled: jest.fn(),
    getJson: jest.fn(),
    setJson: jest.fn(),
    setNumericMax: jest.fn(),
    publish: jest.fn(),
  };
  const config = { get: jest.fn() };
  const svc = new SessionRevocationService(redis as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue(undefined);
    redis.setJson.mockResolvedValue(true);
    redis.setNumericMax.mockResolvedValue(true);
    redis.publish.mockResolvedValue(true);
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

    it('announces nothing, so live sockets are left connected', async () => {
      await svc.revokeUser('u1');
      await svc.revokeSession('s1');
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('reports a durable user revocation as pending', async () => {
      await expect(svc.revokeUserAt('u1', 1_700_000_000_500)).resolves.toBe(
        false,
      );
      expect(redis.setJson).not.toHaveBeenCalled();
      expect(redis.publish).not.toHaveBeenCalled();
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

    it('uses millisecond issuance time so a fresh same-second token survives', async () => {
      redis.getJson.mockImplementation((key: string) =>
        Promise.resolve(key === 'authrev:u:u1' ? 1_700_000_000_500 : null),
      );
      await expect(
        svc.isRevoked({
          sub: 'u1',
          sid: 's1',
          iat: 1_700_000_000,
          issuedAtMs: 1_700_000_000_600,
        } as never),
      ).resolves.toBe(false);
    });

    it('flags a legacy token issued in the same second as user revocation', async () => {
      redis.getJson.mockImplementation((key: string) =>
        Promise.resolve(key === 'authrev:u:u1' ? 1_700_000_000_500 : null),
      );
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 1_700_000_000 }),
      ).resolves.toBe(true);
    });

    it('does NOT flag when no markers exist', async () => {
      redis.getJson.mockResolvedValue(null);
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(false);
    });

    it('revokeUser stores a millisecond epoch under the per-user key', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(1_700_000_000_500);
      await svc.revokeUser('u1');
      expect(redis.setNumericMax).toHaveBeenCalledWith(
        'authrev:u:u1',
        1_700_000_000_500,
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

    it('announces a user revocation on the realtime backplane', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(1_700_000_000_500);
      await svc.revokeUser('u1');
      expect(redis.publish).toHaveBeenCalledWith(
        SESSION_REVOCATION_CHANNEL,
        JSON.stringify({
          kind: 'user',
          userId: 'u1',
          revokedAtMs: 1_700_000_000_500,
        }),
      );
    });

    it('completes a durable user revocation at its original epoch', async () => {
      await expect(svc.revokeUserAt('u1', 1_700_000_000_500)).resolves.toBe(
        true,
      );
      expect(redis.setNumericMax).toHaveBeenCalledWith(
        'authrev:u:u1',
        1_700_000_000_500,
        expect.any(Number),
      );
      expect(redis.publish).toHaveBeenCalledWith(
        SESSION_REVOCATION_CHANNEL,
        JSON.stringify({
          kind: 'user',
          userId: 'u1',
          revokedAtMs: 1_700_000_000_500,
        }),
      );
    });

    it('keeps a durable user revocation pending when the marker write returns false', async () => {
      redis.setNumericMax.mockResolvedValue(false);

      await expect(svc.revokeUserAt('u1', 1_700_000_000_500)).resolves.toBe(
        false,
      );
      expect(redis.publish).not.toHaveBeenCalled();
    });

    it('keeps a durable user revocation pending when publish returns false', async () => {
      redis.publish.mockResolvedValue(false);

      await expect(svc.revokeUserAt('u1', 1_700_000_000_500)).resolves.toBe(
        false,
      );
    });

    it('cannot roll a newer revocation marker back with a late older job', async () => {
      let storedMarker = 0;
      redis.setNumericMax.mockImplementation(
        async (_key: string, incoming: number) => {
          storedMarker = Math.max(storedMarker, incoming);
          return true;
        },
      );

      await svc.revokeUserAt('u1', 1_700_000_000_900);
      await svc.revokeUserAt('u1', 1_700_000_000_500);

      expect(storedMarker).toBe(1_700_000_000_900);
    });

    it('keeps a durable user revocation pending when socket broadcast fails', async () => {
      redis.publish.mockRejectedValue(new Error('redis gone'));

      await expect(svc.revokeUserAt('u1', 1_700_000_000_500)).resolves.toBe(
        false,
      );
      expect(redis.setNumericMax).toHaveBeenCalled();
    });

    it('announces a session revocation on the realtime backplane', async () => {
      await svc.revokeSession('s1');
      expect(redis.publish).toHaveBeenCalledWith(
        SESSION_REVOCATION_CHANNEL,
        JSON.stringify({ kind: 'session', sessionId: 's1' }),
      );
    });

    it('still revokes when the announce fails', async () => {
      // The marker is what protects HTTP; a backplane hiccup must not turn a
      // ban into an error, it just costs the socket-close half.
      redis.publish.mockRejectedValue(new Error('redis gone'));
      await expect(svc.revokeUser('u1')).resolves.toBeUndefined();
      expect(redis.setNumericMax).toHaveBeenCalled();
    });

    it('keeps revocation markers for the configured access-token lifetime', async () => {
      config.get.mockReturnValue('2d');
      const configuredSvc = new SessionRevocationService(
        redis as never,
        config as never,
      );

      await configuredSvc.revokeSession('s1');

      expect(redis.setJson).toHaveBeenCalledWith(
        'authrev:s:s1',
        1,
        2 * 24 * 60 * 60,
      );
    });

    it('computes when a durable user revocation is no longer needed', () => {
      config.get.mockReturnValue('2d');
      const configuredSvc = new SessionRevocationService(
        redis as never,
        config as never,
      );

      expect(configuredSvc.revocationExpiresAt(1_700_000_000_500)).toEqual(
        new Date(1_700_000_000_500 + 2 * 24 * 60 * 60 * 1000),
      );
    });
  });
});
