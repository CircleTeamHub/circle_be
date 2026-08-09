import { ForbiddenException } from '@nestjs/common';
import { AppAudienceGuard } from '../app-audience.guard';

const contextFor = (user: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as never;

describe('AppAudienceGuard', () => {
  const guard = new AppAudienceGuard();

  it('allows an app session', () => {
    expect(guard.canActivate(contextFor({ audience: 'APP' }))).toBe(true);
  });

  // 管理台走 /auth/admin/login 拿的是 ADMIN audience,它同样能过 JwtGuard,
  // 而管理台没有任何消息/通话 UI。拆 OpenIM 前这道闸在 /auth/im-token 里,
  // 自研栈直接复用 app JWT,闸随端点一起没了 —— 迁移带回来的能力扩张。
  it('rejects an admin session', () => {
    expect(() => guard.canActivate(contextFor({ audience: 'ADMIN' }))).toThrow(
      ForbiddenException,
    );
  });

  it.each([undefined, null, {}, { audience: undefined }])(
    'rejects a request with no resolvable app audience (%p)',
    (user) => {
      expect(() => guard.canActivate(contextFor(user))).toThrow(
        ForbiddenException,
      );
    },
  );
});
