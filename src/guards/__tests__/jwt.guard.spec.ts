import { UnauthorizedException } from '@nestjs/common';
import { JwtGuard } from '../jwt.guard';
import {
  getAuthFailureReason,
  isRoutineAuthFailure,
} from 'src/logging/handled-errors';

/**
 * Mirrors what jsonwebtoken hands passport-jwt: every error is a
 * JsonWebTokenError, the specialised ones override `name`.
 */
function jwtError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function reject(guard: JwtGuard, info: unknown): unknown {
  try {
    guard.handleRequest(null, null, info);
  } catch (error) {
    return error;
  }
  throw new Error('expected handleRequest to throw');
}

describe('JwtGuard.handleRequest', () => {
  const guard = new JwtGuard();

  it('returns the authenticated user untouched', () => {
    const user = { userId: 'u-1' };
    expect(guard.handleRequest(null, user, undefined)).toBe(user);
  });

  it('rethrows a strategy error as-is (revoked session keeps its own exception)', () => {
    const revoked = new UnauthorizedException('Session revoked');
    expect(() => guard.handleRequest(revoked, null, undefined)).toThrow(
      revoked,
    );
    expect(getAuthFailureReason(revoked)).toBeUndefined();
  });

  it.each([
    [jwtError('TokenExpiredError', 'jwt expired'), 'token_expired', true],
    [new Error('No auth token'), 'token_missing', true],
    [jwtError('JsonWebTokenError', 'jwt malformed'), 'token_invalid', false],
    [
      jwtError('JsonWebTokenError', 'invalid signature'),
      'token_invalid',
      false,
    ],
    [
      jwtError('JsonWebTokenError', 'jwt audience invalid. expected: APP'),
      'token_invalid',
      false,
    ],
    [jwtError('NotBeforeError', 'jwt not active'), 'token_not_active', false],
    [undefined, 'token_invalid', false],
    ['unexpected string info', 'token_invalid', false],
  ])(
    'classifies passport info %p as %s (routine: %s)',
    (info, reason, routine) => {
      const exception = reject(guard, info);

      expect(exception).toBeInstanceOf(UnauthorizedException);
      expect((exception as UnauthorizedException).getStatus()).toBe(401);
      // Response contract is the passport default; the reason is log-only.
      expect((exception as UnauthorizedException).message).toBe('Unauthorized');
      expect(getAuthFailureReason(exception)).toBe(reason);
      expect(isRoutineAuthFailure(exception)).toBe(routine);
    },
  );
});
