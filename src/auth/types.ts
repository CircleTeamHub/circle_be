import type { Request } from 'express';

/** Body of a signed access token. */
export interface JwtPayload {
  sub: string;
  accountId: string;
  role: string;
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
}

/** Express Request with the JWT-derived user attached. */
export type RequestWithUser = Request & { user: AuthenticatedUser };
