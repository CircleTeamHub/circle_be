import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

async function propertiesInError(input: Record<string, unknown>) {
  const errors = await validate(plainToInstance(LoginDto, input));
  return errors
    .map((error) => error.property)
    .sort((a: string, b: string) => a.localeCompare(b));
}

/**
 * 这个 DTO 的唯一职责是「别让 auth.service 的 identifier/email 兜底失效」。
 * 那里是 `dto.identifier?.trim() || dto.email?.trim()`:null / '' / 全空白的
 * identifier 都会落到 email 上,所以这三种输入必须照样能登录。
 *
 * 反方向同样重要:非字符串的 identifier 进不了 `.trim()`,必须在这里被拦成 400,
 * 否则就是服务层一个 500。
 */
describe('LoginDto identifier / email fallback', () => {
  it('accepts an identifier on its own', async () => {
    expect(
      await propertiesInError({
        identifier: 'user@example.com',
        password: 'password1',
      }),
    ).toEqual([]);
  });

  it('accepts the deprecated email alias on its own', async () => {
    expect(
      await propertiesInError({
        email: 'user@example.com',
        password: 'password1',
      }),
    ).toEqual([]);
  });

  it('still falls back to email when identifier is an empty string', async () => {
    expect(
      await propertiesInError({
        identifier: '',
        email: 'user@example.com',
        password: 'password1',
      }),
    ).toEqual([]);
  });

  it('still falls back to email when identifier is null', async () => {
    expect(
      await propertiesInError({
        identifier: null,
        email: 'user@example.com',
        password: 'password1',
      }),
    ).toEqual([]);
  });

  it('still falls back to email when identifier is only whitespace', async () => {
    expect(
      await propertiesInError({
        identifier: '   ',
        email: 'user@example.com',
        password: 'password1',
      }),
    ).toEqual([]);
  });

  it('rejects a request that carries neither identifier nor email', async () => {
    expect(await propertiesInError({ password: 'password1' })).toEqual([
      'email',
      'identifier',
    ]);
  });

  it('rejects a blank identifier when there is no email to fall back to', async () => {
    expect(
      await propertiesInError({ identifier: '   ', password: 'password1' }),
    ).toContain('email');
  });

  it('still validates identifier when the deprecated email alias is also present', async () => {
    // 非字符串:服务层会对它调 .trim(),放过去就是 500。
    expect(
      await propertiesInError({
        identifier: 42,
        email: 'user@example.com',
        password: 'password1',
      }),
    ).toContain('identifier');
  });

  it('rejects a malformed email when identifier is blank', async () => {
    expect(
      await propertiesInError({
        identifier: '',
        email: 'not-an-email',
        password: 'password1',
      }),
    ).toContain('email');
  });
});

// platform 是装机的旧版 APP 仍在发的字段（登录、注册都带 getClientPlatformID()，
// 取值 1/2/5）。服务端早就不读它；可在 forbidNonWhitelisted 下属性一删，这些安装包的
// 登录就会 400。所以属性保留、照旧校验，只从 OpenAPI 里隐藏。
describe('LoginDto platform (deprecated: accepted and ignored)', () => {
  // 与全局 ValidationPipe 同一组选项（src/setup.ts）。
  const validateLikePipe = (input: Record<string, unknown>) =>
    validate(
      plainToInstance(LoginDto, input, { enableImplicitConversion: true }),
      { whitelist: true, forbidNonWhitelisted: true },
    );

  it.each([1, 2, 5])(
    'still accepts platform %s from installed app builds',
    async (platform) => {
      expect(
        await validateLikePipe({
          identifier: 'user@example.com',
          password: 'password1',
          platform,
        }),
      ).toHaveLength(0);
    },
  );

  it('keeps validating the value as before', async () => {
    const errors = await validateLikePipe({
      identifier: 'user@example.com',
      password: 'password1',
      platform: 3,
    });
    expect(
      errors.find((error) => error.property === 'platform')?.constraints,
    ).toHaveProperty('isIn');
  });

  it('is no longer documented in the OpenAPI schema', () => {
    const documented: string[] =
      Reflect.getMetadata(
        'swagger/apiModelPropertiesArray',
        LoginDto.prototype,
      ) ?? [];
    expect(documented).toContain(':password');
    expect(documented).not.toContain(':platform');
  });
});
