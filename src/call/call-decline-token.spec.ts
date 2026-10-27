import {
  DECLINE_TOKEN_GRACE_SECONDS,
  deriveDeclineTokenKey,
  issueDeclineToken,
  verifyDeclineToken,
} from './call-decline-token';

describe('call push decline token', () => {
  const key = deriveDeclineTokenKey('test-secret-for-call-push');
  const callId = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
  const userId = '7d0f4a52-2c1b-4b8e-9a3e-5f6a7b8c9d0e';
  const ringExpiresAt = new Date('2026-10-26T12:00:45.000Z');
  const duringRing = new Date('2026-10-26T12:00:30.000Z');

  it('round-trips the user for the call it was issued for', () => {
    const token = issueDeclineToken(key, callId, userId, ringExpiresAt);

    expect(token).toMatch(/^v1\.[0-9a-f-]+\.\d+\.[A-Za-z0-9_-]+$/);
    expect(verifyDeclineToken(key, callId, token, duringRing)).toBe(userId);
  });

  it('stays valid for a short grace period after the ring ends, then expires', () => {
    const token = issueDeclineToken(key, callId, userId, ringExpiresAt);
    const justInsideGrace = new Date(
      ringExpiresAt.getTime() + (DECLINE_TOKEN_GRACE_SECONDS - 1) * 1000,
    );
    const afterGrace = new Date(
      ringExpiresAt.getTime() + (DECLINE_TOKEN_GRACE_SECONDS + 1) * 1000,
    );

    expect(verifyDeclineToken(key, callId, token, justInsideGrace)).toBe(
      userId,
    );
    expect(verifyDeclineToken(key, callId, token, afterGrace)).toBeNull();
  });

  it('cannot be replayed against another call', () => {
    const token = issueDeclineToken(key, callId, userId, ringExpiresAt);

    expect(
      verifyDeclineToken(
        key,
        '00000000-0000-4000-8000-000000000000',
        token,
        duringRing,
      ),
    ).toBeNull();
  });

  it('rejects a token whose user or expiry was edited', () => {
    const token = issueDeclineToken(key, callId, userId, ringExpiresAt);
    const [version, , exp, mac] = token.split('.');
    const otherUser = [
      version,
      '11111111-2222-4333-8444-555555555555',
      exp,
      mac,
    ].join('.');
    const longerLived = [version, userId, String(Number(exp) + 3600), mac].join(
      '.',
    );

    expect(verifyDeclineToken(key, callId, otherUser, duringRing)).toBeNull();
    expect(verifyDeclineToken(key, callId, longerLived, duringRing)).toBeNull();
  });

  it('rejects tokens signed with another key', () => {
    const token = issueDeclineToken(
      deriveDeclineTokenKey('some-other-secret'),
      callId,
      userId,
      ringExpiresAt,
    );

    expect(verifyDeclineToken(key, callId, token, duringRing)).toBeNull();
  });

  it.each([
    [''],
    ['v1'],
    ['v2.user.123.mac'],
    ['v1.not a user.123.mac'],
    ['v1.7d0f4a52.notanumber.mac'],
    ['v1.7d0f4a52.123.short'],
    ['v1.7d0f4a52.123.mac.extra'],
  ])('rejects malformed token %p without throwing', (token) => {
    expect(verifyDeclineToken(key, callId, token, duringRing)).toBeNull();
  });
});
