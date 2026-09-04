import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  type AuthFailureReason,
  markAuthFailureReason,
} from '../logging/handled-errors';

function readString(
  value: unknown,
  key: 'name' | 'message',
): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * passport-jwt reports why it failed through `info`: a jsonwebtoken error
 * (`TokenExpiredError`, `NotBeforeError`, or the base `JsonWebTokenError` for
 * a malformed / wrongly signed / wrong audience-issuer token) or a plain
 * `Error('No auth token')` when the header is absent. Anything unrecognised
 * is treated as invalid so it is never silently dropped from the security log.
 */
function classifyAuthFailure(info: unknown): AuthFailureReason {
  const name = readString(info, 'name');
  if (name === 'TokenExpiredError') return 'token_expired';
  if (name === 'NotBeforeError') return 'token_not_active';
  if (readString(info, 'message') === 'No auth token') return 'token_missing';
  return 'token_invalid';
}

export class JwtGuard extends AuthGuard('jwt') {
  constructor() {
    super();
  }

  /**
   * Same outcome as the passport default (rethrow a strategy error, otherwise
   * a bare 401) but the rejection reason is attached to the exception so
   * AllExceptionFilter can keep routine expiry / missing-token churn out of
   * the security log. The response body is unchanged; `info` never reaches
   * the client.
   */
  handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser | false | null | undefined,
    info: unknown,
  ): TUser {
    if (err) {
      throw err;
    }
    if (!user) {
      const exception = new UnauthorizedException();
      markAuthFailureReason(exception, classifyAuthFailure(info));
      throw exception;
    }
    return user;
  }
}

// 装饰器
// @JwtGuard()
