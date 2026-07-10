import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { NotificationModule } from './notification.module';
import { NotificationPublicController } from './notification-public.controller';

describe('NotificationPublicController', () => {
  it('exposes a throttled public DELETE route without the JWT guard', () => {
    const revoke = NotificationPublicController.prototype.revokePushToken;
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      NotificationPublicController,
    );

    expect(
      Reflect.getMetadata(PATH_METADATA, NotificationPublicController),
    ).toBe('notification');
    expect(Reflect.getMetadata(PATH_METADATA, revoke)).toBe(
      'push-token/revoke',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, revoke)).toBe(
      RequestMethod.DELETE,
    );
    expect(guards).toEqual([ThrottlerGuard]);
    expect(guards).not.toContain(JwtGuard);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', revoke)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', revoke)).toBe(60_000);
  });

  it('passes the opaque revocation payload to the service', async () => {
    const service = {
      revokePushToken: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new NotificationPublicController(service as any);
    const dto = {
      token: 'ExponentPushToken[abc]',
      revocationSecret: 's'.repeat(32),
    };

    await expect(controller.revokePushToken(dto)).resolves.toBeUndefined();
    expect(service.revokePushToken).toHaveBeenCalledWith(dto);
  });

  it('is wired alongside the authenticated controller in NotificationModule', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      NotificationModule,
    );
    expect(controllers).toContain(NotificationPublicController);
  });
});
