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
  const CALLER_IP = '203.0.113.9';
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
    service.revokePushToken.mockResolvedValue(false);
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

  it('uses Redis with a hashed per-CALLER key after a no-op revocation', async () => {
    // 键必须来自调用方 IP，不能来自 dto.token —— token 是攻击者提供的，按它计数
    // 等于每换一个 token 就开一个新桶，暴力扫描永远撞不到上限。
    const ipHash = createHash('sha256').update(CALLER_IP).digest('hex');

    await expect(
      controller().revokePushToken(dto, CALLER_IP),
    ).resolves.toBeUndefined();

    expect(redisService.incrementWithTtl).toHaveBeenCalledWith(
      `rl:push-token-revoke:ip:${ipHash}`,
      60,
    );
    // IP 是个人数据，不该以明文进 Redis 键。
    expect(redisService.incrementWithTtl.mock.calls[0][0]).not.toContain(
      CALLER_IP,
    );
    expect(redisService.incrementWithTtl.mock.calls[0][0]).not.toContain(
      dto.token,
    );
    expect(service.revokePushToken).toHaveBeenCalledWith(dto);
    expect(service.revokePushToken.mock.invocationCallOrder[0]).toBeLessThan(
      redisService.incrementWithTtl.mock.invocationCallOrder[0],
    );
  });

  it('rejects Redis count 11 only after the revocation attempt is a no-op', async () => {
    redisService.incrementWithTtl.mockResolvedValue(11);

    await expect(
      controller().revokePushToken(dto, CALLER_IP),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(service.revokePushToken).toHaveBeenCalledWith(dto);
  });

  it('falls back in memory and rejects the controller-level 11th request when Redis errors', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const instance = controller();

    for (let index = 0; index < 10; index += 1) {
      await instance.revokePushToken(dto, CALLER_IP);
    }
    await expect(
      instance.revokePushToken(dto, CALLER_IP),
    ).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(service.revokePushToken).toHaveBeenCalledTimes(11);
  });

  it('rotating the token does NOT buy a fresh bucket (the brute-force fix)', async () => {
    // 这条以前断言的是反面：不同 token 各自独立计数。那正是漏洞 —— 扫描器每次
    // 换个 token 就重置额度，限流从未生效过。同一个 IP 无论换多少 token，都必须
    // 共用同一个桶。
    redisService.isEnabled.mockReturnValue(false);
    const instance = controller();

    for (let index = 0; index < 10; index += 1) {
      await instance.revokePushToken(
        { ...dto, token: `ExponentPushToken[scan-${index}]` },
        CALLER_IP,
      );
    }
    await expect(
      instance.revokePushToken(
        { ...dto, token: 'ExponentPushToken[scan-11]' },
        CALLER_IP,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(redisService.incrementWithTtl).not.toHaveBeenCalled();
  });

  it('keeps different callers independent in the local fallback', async () => {
    // 一个 IP 打满不能连累别人（运营商 NAT 后面是很多真实用户）。
    redisService.isEnabled.mockReturnValue(false);
    const instance = controller();

    for (let index = 0; index < 10; index += 1) {
      await instance.revokePushToken(dto, CALLER_IP);
    }
    await expect(
      instance.revokePushToken(dto, '198.51.100.7'),
    ).resolves.toBeUndefined();
    await expect(
      instance.revokePushToken(dto, CALLER_IP),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('never blocks a valid revocation after ten failed attempts, then rejects the next failure', async () => {
    redisService.isEnabled.mockReturnValue(false);
    service.revokePushToken
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const instance = controller();

    for (let index = 0; index < 10; index += 1) {
      await expect(
        instance.revokePushToken(
          {
            ...dto,
            revocationSecret: `wrong-secret-${String(index).padStart(20, '0')}`,
          },
          CALLER_IP,
        ),
      ).resolves.toBeUndefined();
    }

    await expect(
      instance.revokePushToken(dto, CALLER_IP),
    ).resolves.toBeUndefined();
    await expect(
      instance.revokePushToken(
        { ...dto, revocationSecret: 'another-wrong-secret-that-is-long' },
        CALLER_IP,
      ),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(service.revokePushToken).toHaveBeenCalledTimes(12);
  });

  it('keeps missing-token and wrong-secret no-op responses indistinguishable', async () => {
    redisService.isEnabled.mockReturnValue(false);
    const instance = controller();
    const wrongSecret = {
      ...dto,
      revocationSecret: 'wrong-secret-that-is-long-enough',
    };
    const missingToken = {
      ...dto,
      token: 'ExponentPushToken[missing]',
    };

    await expect(
      instance.revokePushToken(wrongSecret, CALLER_IP),
    ).resolves.toBeUndefined();
    await expect(
      instance.revokePushToken(missingToken, CALLER_IP),
    ).resolves.toBeUndefined();
  });

  it('is wired alongside the authenticated controller in NotificationModule', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      NotificationModule,
    );
    expect(controllers).toContain(NotificationPublicController);
  });
});
