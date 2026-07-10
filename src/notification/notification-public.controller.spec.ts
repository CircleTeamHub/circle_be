import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { createHash } from 'crypto';
import { JwtGuard } from 'src/guards/jwt.guard';
import { RedisService } from 'src/redis/redis.service';
import { NotificationModule } from './notification.module';
import { NotificationPublicController } from './notification-public.controller';

describe('NotificationPublicController', () => {
  const service = {
    revokePushToken: jest.fn().mockResolvedValue(undefined),
  };
  const redisService = {
    isEnabled: jest.fn(),
    incrementWithTtl: jest.fn(),
  };
  const dto = {
    token: 'ExponentPushToken[abc]',
    revocationSecret: 's'.repeat(32),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service.revokePushToken.mockResolvedValue(undefined);
    redisService.isEnabled.mockReturnValue(true);
    redisService.incrementWithTtl.mockResolvedValue(1);
  });

  const controller = () =>
    new NotificationPublicController(
      service as any,
      redisService as unknown as RedisService,
    );

  it('exposes a public DELETE route without JWT or IP throttler guards', () => {
    const revoke = NotificationPublicController.prototype.revokePushToken;
    const guards =
      Reflect.getMetadata(GUARDS_METADATA, NotificationPublicController) ?? [];

    expect(
      Reflect.getMetadata(PATH_METADATA, NotificationPublicController),
    ).toBe('notification');
    expect(Reflect.getMetadata(PATH_METADATA, revoke)).toBe(
      'push-token/revoke',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, revoke)).toBe(
      RequestMethod.DELETE,
    );
    expect(guards).toEqual([]);
    expect(guards).not.toContain(JwtGuard);
  });

  it('uses Redis with a hashed per-token key before revoking', async () => {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');

    await expect(controller().revokePushToken(dto)).resolves.toBeUndefined();

    expect(redisService.incrementWithTtl).toHaveBeenCalledWith(
      `rl:push-token-revoke:token:${tokenHash}`,
      60,
    );
    expect(redisService.incrementWithTtl.mock.calls[0][0]).not.toContain(
      dto.token,
    );
    expect(service.revokePushToken).toHaveBeenCalledWith(dto);
  });

  it('rejects Redis count 11 before calling the revocation service', async () => {
    redisService.incrementWithTtl.mockResolvedValue(11);

    await expect(controller().revokePushToken(dto)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(service.revokePushToken).not.toHaveBeenCalled();
  });

  it('falls back in memory and rejects the controller-level 11th request when Redis errors', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const instance = controller();

    for (let index = 0; index < 10; index += 1) {
      await instance.revokePushToken(dto);
    }
    await expect(instance.revokePushToken(dto)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(service.revokePushToken).toHaveBeenCalledTimes(10);
  });

  it('keeps different token buckets independent in the local fallback', async () => {
    redisService.isEnabled.mockReturnValue(false);
    const instance = controller();
    const otherDto = {
      ...dto,
      token: 'ExponentPushToken[different]',
    };

    for (let index = 0; index < 10; index += 1) {
      await instance.revokePushToken(dto);
    }
    await expect(instance.revokePushToken(otherDto)).resolves.toBeUndefined();
    await expect(instance.revokePushToken(dto)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(redisService.incrementWithTtl).not.toHaveBeenCalled();
  });

  it('is wired alongside the authenticated controller in NotificationModule', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      NotificationModule,
    );
    expect(controllers).toContain(NotificationPublicController);
  });
});
