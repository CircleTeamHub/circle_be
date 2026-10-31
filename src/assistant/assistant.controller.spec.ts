import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AssistantController } from './assistant.controller';

describe('AssistantController', () => {
  it('only lets app sessions use the assistant', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AssistantController);
    expect(guards).toEqual([JwtGuard, AppAudienceGuard]);

    const contextFor = (audience: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user: { audience } }) }),
      }) as never;
    const guard = new AppAudienceGuard();
    expect(() => guard.canActivate(contextFor('ADMIN'))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(contextFor('APP'))).toBe(true);
  });
});
