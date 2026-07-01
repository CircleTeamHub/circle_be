import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

export const OPENIM_CALLBACK_SECRET_HEADER = 'x-openim-callback-secret';

/**
 * Guards the OpenIM before-send callbacks. OpenIM does not authenticate its
 * callback requests, so without this these routes are open to the internet and
 * every call hits the database. When `OPENIM_CALLBACK_SECRET` is configured the
 * guard requires a matching secret (via the `x-openim-callback-secret` header
 * or a `token` query param, whichever the deployment's proxy can inject). When
 * it is unset the guard is a no-op, preserving the behavior of deployments that
 * isolate the callback at the network layer.
 */
@Injectable()
export class OpenimCallbackGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('OPENIM_CALLBACK_SECRET')?.trim();
    if (!expected) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (this.extractSecret(request) !== expected) {
      throw new UnauthorizedException('Invalid OpenIM callback credentials');
    }
    return true;
  }

  private extractSecret(request: Request): string | null {
    const header = request.headers[OPENIM_CALLBACK_SECRET_HEADER];
    if (typeof header === 'string' && header.length > 0) {
      return header;
    }
    const token = request.query?.token;
    if (typeof token === 'string' && token.length > 0) {
      return token;
    }
    return null;
  }
}
