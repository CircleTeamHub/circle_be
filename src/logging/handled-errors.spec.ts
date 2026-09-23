import {
  getAuthFailureReason,
  isRoutineAuthFailure,
  markAuthFailureReason,
  markErrorCaptured,
  markSecurityEventLogged,
  wasErrorCaptured,
  wasSecurityEventLogged,
} from './handled-errors';
import { runWithRequestContext } from './request-context';

const context = (requestId: string) => ({
  requestId,
  traceId: requestId,
  method: 'GET',
  path: '/api/v1/auth/me',
});

describe('handled-errors markers', () => {
  it('tracks capture and security-log state per exception instance', () => {
    const first = new Error('a');
    const second = new Error('b');

    runWithRequestContext(context('request-a'), () => {
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

    runWithRequestContext(context('request-b'), () => {
      expect(wasErrorCaptured(first)).toBe(false);
      expect(wasSecurityEventLogged(first)).toBe(false);
    });
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

  it('can carry an explicitly captured request context across async boundaries', () => {
    const error = new Error('async failure');
    const requestContext = context('request-async');
    const otherContext = context('request-async');
    markErrorCaptured(error, requestContext);
    markSecurityEventLogged(error, requestContext);

    expect(wasErrorCaptured(error, requestContext)).toBe(true);
    expect(wasSecurityEventLogged(error, requestContext)).toBe(true);
    expect(wasErrorCaptured(error)).toBe(false);
    expect(wasSecurityEventLogged(error)).toBe(false);
    expect(wasErrorCaptured(error, otherContext)).toBe(false);
    expect(wasSecurityEventLogged(error, otherContext)).toBe(false);
  });

  it('does not conflate different requests that reuse the same client id', () => {
    const error = new Error('reused singleton');
    const firstRequest = context('same-client-id');
    const secondRequest = context('same-client-id');

    markErrorCaptured(error, firstRequest);
    markSecurityEventLogged(error, firstRequest);

    expect(wasErrorCaptured(error, secondRequest)).toBe(false);
    expect(wasSecurityEventLogged(error, secondRequest)).toBe(false);
  });

  it('keeps a best-effort marker when async context is unavailable', () => {
    const error = new Error('contextless failure');
    markErrorCaptured(error);
    markSecurityEventLogged(error);

    runWithRequestContext(context('later-filter'), () => {
      expect(wasErrorCaptured(error)).toBe(true);
      expect(wasSecurityEventLogged(error)).toBe(true);
    });
    expect(wasErrorCaptured(error)).toBe(false);
    expect(wasSecurityEventLogged(error)).toBe(false);
  });

  it('classifies only missing / expired tokens as routine auth failures', () => {
    const unclassified = new Error('custom guard');
    expect(getAuthFailureReason(unclassified)).toBeUndefined();
    expect(isRoutineAuthFailure(unclassified)).toBe(false);

    runWithRequestContext(context('request-auth'), () => {
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
});
