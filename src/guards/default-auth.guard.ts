import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtGuard } from './jwt.guard';
import { ANONYMOUS_ACCESS } from './anonymous-access.decorator';

/** New HTTP routes require a session unless explicitly reviewed as anonymous. */
@Injectable()
export class DefaultAuthGuard extends JwtGuard {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    if (this.reflector.get<string>(ANONYMOUS_ACCESS, context.getHandler())) {
      return true;
    }
    // Existing route guards still run. Avoid verifying a session twice per request.
    const guards: unknown[] = [
      ...(this.reflector.get<unknown[]>(GUARDS_METADATA, context.getClass()) ??
        []),
      ...(this.reflector.get<unknown[]>(
        GUARDS_METADATA,
        context.getHandler(),
      ) ?? []),
    ];
    if (guards.includes(JwtGuard)) return true;
    return super.canActivate(context);
  }
}
