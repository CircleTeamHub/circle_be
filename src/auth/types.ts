import type { Request } from 'express';

export type TokenAudience = 'APP' | 'ADMIN';

/** Body of a signed access token. */
export interface JwtPayload {
  sub: string;
  accountId: string;
  role: string;
  /** Token audience. ADMIN tokens are required by AdminGuard. */
  aud?: TokenAudience;
  /** Refresh-token session id used for device management. */
  sid?: string;
  /** Issued-at, populated by @nestjs/jwt. */
  iat?: number;
  /** Expiration, populated by @nestjs/jwt. */
  exp?: number;
}

/** Shape attached to `req.user` after `JwtGuard` passes. */
export interface AuthenticatedUser {
  userId: string;
  accountId: string;
  role: string;
  audience?: TokenAudience;
  sessionId?: string;
}

/** Express Request with the JWT-derived user attached. */
export type RequestWithUser = Request & { user: AuthenticatedUser };
