import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthErrorCode } from 'src/common/app-error-codes';

/**
 * PR #120 review 修复回归：reset-request 在冷却窗口内必须对
 * 已注册/未注册邮箱表现一致（静默成功），否则 60s 内连发两次就是
 * 一个账号存在性探针（已注册 → CodeRateLimited，未注册 → 恒成功）。
 */
describe('requestPasswordReset anti-enumeration (PR #120 review)', () => {
  function buildService(requestCode: jest.Mock) {
    return new AuthService(
      {} as never, // prisma —— 本路径不触达
      {} as never, // refreshTokenService
      {} as never, // jwt
      {} as never, // openim
      {} as never, // iconService
      { requestCode } as never,
    );
  }

  it('swallows CodeRateLimited into silent success (registered email, repeat within 60s)', async () => {
    const requestCode = jest.fn().mockRejectedValue(
      new BadRequestException({
        message: '验证码发送过于频繁，请稍后再试',
        errorCode: AuthErrorCode.CodeRateLimited,
      }),
    );
    const service = buildService(requestCode);

    // 已注册邮箱撞冷却 → 与未注册邮箱一样静默成功
    await expect(
      service.requestPasswordReset('known@example.com'),
    ).resolves.toBeUndefined();
    expect(requestCode).toHaveBeenCalledWith(
      'known@example.com',
      'RESET_PASSWORD',
    );
  });

  it('still propagates non-cooldown failures (mailer outage must stay visible)', async () => {
    const requestCode = jest
      .fn()
      .mockRejectedValue(new Error('smtp connect timeout'));
    const service = buildService(requestCode);

    await expect(
      service.requestPasswordReset('known@example.com'),
    ).rejects.toThrow('smtp connect timeout');
  });
});
