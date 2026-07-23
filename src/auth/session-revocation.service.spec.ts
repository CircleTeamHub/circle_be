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
    getJsonMany: jest.fn(),
    setJson: jest.fn(),
    publish: jest.fn(),
  };
  const config = { get: jest.fn() };
  const svc = new SessionRevocationService(redis as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue(undefined);
    redis.getJsonMany.mockResolvedValue([]);
    redis.setJson.mockResolvedValue(true);
    redis.publish.mockResolvedValue(true);
  });

  describe('fail-open when Redis is disabled', () => {
    beforeEach(() => redis.isEnabled.mockReturnValue(false));

    it('isRevoked returns false and never reads Redis', async () => {
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(false);
      expect(redis.getJson).not.toHaveBeenCalled();
      expect(redis.getJsonMany).not.toHaveBeenCalled();
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
  });

  describe('with Redis enabled', () => {
    beforeEach(() => redis.isEnabled.mockReturnValue(true));

    it('flags a token whose session was revoked (single logout)', async () => {
      redis.getJsonMany.mockResolvedValue([1, null]);
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(true);
    });

    it('flags a token issued before the user revoke-after stamp', async () => {
      redis.getJsonMany.mockResolvedValue([null, 200]);
      // iat 100 < revokedAfter 200 → revoked.
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(true);
    });

    it('uses millisecond issuance time so a fresh same-second token survives', async () => {
      redis.getJsonMany.mockResolvedValue([null, 1_700_000_000_500]);
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
      redis.getJsonMany.mockResolvedValue([null, 1_700_000_000_500]);
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 1_700_000_000 }),
      ).resolves.toBe(true);
    });

    it('does NOT flag when no markers exist', async () => {
      redis.getJsonMany.mockResolvedValue([null, null]);
      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(false);
    });

    it('reads session and user markers in one Redis round trip', async () => {
      redis.getJsonMany.mockResolvedValue([null, 200]);

      await expect(
        svc.isRevoked({ sub: 'u1', sid: 's1', iat: 100 }),
      ).resolves.toBe(true);

      expect(redis.getJsonMany).toHaveBeenCalledTimes(1);
      expect(redis.getJsonMany).toHaveBeenCalledWith([
        'authrev:s:s1',
        'authrev:u:u1',
      ]);
      expect(redis.getJson).not.toHaveBeenCalled();
    });

    it('revokeUser stores a millisecond epoch under the per-user key', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(1_700_000_000_500);
      await svc.revokeUser('u1');
      expect(redis.setJson).toHaveBeenCalledWith(
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
      expect(redis.setJson).toHaveBeenCalled();
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
  });
});
