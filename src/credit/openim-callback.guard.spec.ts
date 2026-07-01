import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenimCallbackGuard } from './openim-callback.guard';

function contextFor(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWithSecret(secret: string | undefined): OpenimCallbackGuard {
  const config = {
    get: (key: string) =>
      key === 'OPENIM_CALLBACK_SECRET' ? secret : undefined,
  } as unknown as ConfigService;
  return new OpenimCallbackGuard(config);
}

describe('OpenimCallbackGuard', () => {
  it('allows any request when no secret is configured', () => {
    const guard = guardWithSecret(undefined);
    expect(guard.canActivate(contextFor({ headers: {}, query: {} }))).toBe(
      true,
    );
  });

  it('allows a request with a matching secret header', () => {
    const guard = guardWithSecret('s3cret');
    const ctx = contextFor({
      headers: { 'x-openim-callback-secret': 's3cret' },
      query: {},
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a request with a matching token query param', () => {
    const guard = guardWithSecret('s3cret');
    const ctx = contextFor({ headers: {}, query: { token: 's3cret' } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a request with a missing or wrong secret when one is configured', () => {
    const guard = guardWithSecret('s3cret');
    expect(() =>
      guard.canActivate(contextFor({ headers: {}, query: {} })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(
        contextFor({
          headers: { 'x-openim-callback-secret': 'wrong' },
          query: {},
        }),
      ),
    ).toThrow(UnauthorizedException);
  });
});
