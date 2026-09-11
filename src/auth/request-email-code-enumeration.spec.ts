import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthErrorCode } from 'src/common/app-error-codes';

/**
 * PR #221 review 修复回归：注册发码端点必须对已注册/未注册邮箱表现一致。
 *
 * EmailVerificationService.requestCode 对 REGISTER + 已注册邮箱静默早退（不建行、
 * 不发信），冷却检查与投递失败却只打在**真正发信**的那条分支上。于是 60s 内
 * 连发两次：已注册邮箱 201/201，未注册邮箱 201/400 CodeRateLimited —— 差异本身
 * 就是账号存在性探针。邮件服务故障期同理（只有未注册邮箱会撞到 503）。
 *
 * requestPasswordReset 早就把这两种折成静默成功，这里对齐同一语义。
 */
describe('requestEmailCode anti-enumeration (PR #221 review)', () => {
  function buildService(requestCode: jest.Mock) {
    // 构造参数按位注入到 emailVerification 即可；用变长构造签名让本 spec 对
    // AuthService 后续追加构造参数保持中立。
    const LooseAuthService = AuthService as unknown as new (
      ...args: unknown[]
    ) => AuthService;
    return new LooseAuthService(
      {}, // prisma —— 本路径不触达
      {}, // refreshTokenService
      {}, // jwt
      {}, // iconService
      { requestCode },
      // configService：构造函数体里会读它(readReferralRules)，给个返回
      // undefined 的 get 就够 —— 各项都落到 REFERRAL_DEFAULTS 上。
      { get: () => undefined },
    );
  }

  it('normalizes the email and maps the public purpose onto the enum', async () => {
    const requestCode = jest.fn().mockResolvedValue(undefined);
    const service = buildService(requestCode);

    await expect(
      service.requestEmailCode('  New@Example.COM ', 'register'),
    ).resolves.toBeUndefined();
    expect(requestCode).toHaveBeenCalledWith('new@example.com', 'REGISTER');
  });

  it('swallows CodeRateLimited into silent success (repeat within 60s)', async () => {
    const requestCode = jest.fn().mockRejectedValue(
      new BadRequestException({
        message: '验证码发送过于频繁，请稍后再试',
        errorCode: AuthErrorCode.CodeRateLimited,
      }),
    );
    const service = buildService(requestCode);

    // 未注册邮箱在 requestCode 里真的建行发信，第二次撞冷却；已注册邮箱两次
    // 都静默早退。两边都必须落到同一个「静默成功」上。
    await expect(
      service.requestEmailCode('unregistered@example.com', 'register'),
    ).resolves.toBeUndefined();
  });

  it('swallows mailer outages into silent success (503 must not single out one email)', async () => {
    const requestCode = jest
      .fn()
      .mockRejectedValue(
        new ServiceUnavailableException('验证码发送失败，请稍后再试'),
      );
    const service = buildService(requestCode);

    await expect(
      service.requestEmailCode('unregistered@example.com', 'register'),
    ).resolves.toBeUndefined();
  });

  it('still propagates unexpected failures (a bug must not hide behind anti-enumeration)', async () => {
    const requestCode = jest
      .fn()
      .mockRejectedValue(new Error('prisma connection reset'));
    const service = buildService(requestCode);

    await expect(
      service.requestEmailCode('anyone@example.com', 'register'),
    ).rejects.toThrow('prisma connection reset');
  });

  it('registered and unregistered emails are indistinguishable across a 60s repeat', async () => {
    // 真实语义的最小复刻：REGISTER + 已注册 → 静默早退（resolve）；
    // REGISTER + 未注册 → 第一次发信成功，第二次撞冷却抛 CodeRateLimited。
    const registered = new Set(['known@example.com']);
    const sentAt = new Map<string, number>();
    const requestCode = jest.fn(async (email: string) => {
      if (registered.has(email)) return;
      if (sentAt.has(email)) {
        throw new BadRequestException({
          message: '验证码发送过于频繁，请稍后再试',
          errorCode: AuthErrorCode.CodeRateLimited,
        });
      }
      sentAt.set(email, Date.now());
    });
    const service = buildService(requestCode);

    const probe = async (email: string) => [
      await service
        .requestEmailCode(email, 'register')
        .then(() => 'ok')
        .catch((e: Error) => e.constructor.name),
      await service
        .requestEmailCode(email, 'register')
        .then(() => 'ok')
        .catch((e: Error) => e.constructor.name),
    ];

    expect(await probe('known@example.com')).toEqual(
      await probe('nobody@example.com'),
    );
  });
});
