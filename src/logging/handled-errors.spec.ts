import {
  getAuthFailureReason,
  isRoutineAuthFailure,
  markAuthFailureReason,
  markErrorCaptured,
  markSecurityEventLogged,
  wasErrorCaptured,
  wasSecurityEventLogged,
} from './handled-errors';

describe('handled-errors markers', () => {
  it('tracks capture and security-log state per exception instance', () => {
    const first = new Error('a');
    const second = new Error('b');

    expect(wasErrorCaptured(first)).toBe(false);
    markErrorCaptured(first);
    expect(wasErrorCaptured(first)).toBe(true);
    expect(wasErrorCaptured(second)).toBe(false);

    expect(wasSecurityEventLogged(first)).toBe(false);
    markSecurityEventLogged(first);
    expect(wasSecurityEventLogged(first)).toBe(true);
    // The two ledgers are independent.
    expect(wasErrorCaptured(second)).toBe(false);
    expect(wasSecurityEventLogged(second)).toBe(false);
  });

  it('ignores primitives without throwing (a thrown string cannot be tracked)', () => {
    expect(() => markErrorCaptured('boom')).not.toThrow();
    expect(() => markSecurityEventLogged(42)).not.toThrow();
    expect(() => markAuthFailureReason('boom', 'token_expired')).not.toThrow();
    expect(wasErrorCaptured('boom')).toBe(false);
    expect(wasSecurityEventLogged(null)).toBe(false);
    expect(getAuthFailureReason('boom')).toBeUndefined();
    expect(isRoutineAuthFailure(null)).toBe(false);
  });

  it('classifies only missing / expired tokens as routine auth failures', () => {
    const unclassified = new Error('custom guard');
    expect(getAuthFailureReason(unclassified)).toBeUndefined();
    expect(isRoutineAuthFailure(unclassified)).toBe(false);

    const expired = new Error('expired');
    markAuthFailureReason(expired, 'token_expired');
    expect(getAuthFailureReason(expired)).toBe('token_expired');
    expect(isRoutineAuthFailure(expired)).toBe(true);

    const missing = new Error('missing');
    markAuthFailureReason(missing, 'token_missing');
    expect(isRoutineAuthFailure(missing)).toBe(true);

    const invalid = new Error('invalid');
    markAuthFailureReason(invalid, 'token_invalid');
    expect(isRoutineAuthFailure(invalid)).toBe(false);

    const notActive = new Error('nbf');
    markAuthFailureReason(notActive, 'token_not_active');
    expect(isRoutineAuthFailure(notActive)).toBe(false);
  });
});
