import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

const validPayload = {
  email: 'user@example.com',
  password: 'password1',
  confirmPassword: 'password1',
  nickname: 'User',
};

describe('RegisterDto inviteCode', () => {
  it('accepts an omitted invite code', async () => {
    const errors = await validate(plainToInstance(RegisterDto, validPayload));
    expect(errors).toHaveLength(0);
  });

  it('trims and uppercases a valid invite code', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...validPayload,
      inviteCode: '  AbC-123  ',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect((dto as RegisterDto & { inviteCode?: string }).inviteCode).toBe(
      'ABC-123',
    );
  });

  it('treats whitespace-only input as omitted', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...validPayload,
      inviteCode: '   ',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(
      (dto as RegisterDto & { inviteCode?: string }).inviteCode,
    ).toBeUndefined();
  });

  it('rejects malformed invite codes', async () => {
    const errors = await validate(
      plainToInstance(RegisterDto, {
        ...validPayload,
        inviteCode: 'bad code!',
      }),
    );

    expect(errors.some((error) => error.property === 'inviteCode')).toBe(true);
  });
});

describe('RegisterDto existing fields', () => {
  const validPassword = ['password', '123'].join('');

  function base(): RegisterDto {
    const dto = new RegisterDto();
    dto.email = 'user@example.com';
    dto.password = validPassword;
    dto.confirmPassword = validPassword;
    dto.nickname = 'Jimmy';
    return dto;
  }

  it('accepts a valid payload', async () => {
    expect(await validate(base())).toHaveLength(0);
  });

  it('requires a confirmation password', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'user@example.com',
      password: validPassword,
      nickname: 'Jimmy',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'confirmPassword')).toBe(
      true,
    );
  });

  it('rejects an invalid email', async () => {
    const dto = base();
    dto.email = 'not-an-email';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it('rejects a missing nickname', async () => {
    const dto = base();
    dto.nickname = '';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'nickname')).toBe(true);
  });

  it('rejects a whitespace-only nickname', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...validPayload,
      nickname: '   ',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'nickname')).toBe(true);
  });

  it('trims surrounding whitespace from a nickname', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...validPayload,
      nickname: '  Jimmy  ',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.nickname).toBe('Jimmy');
  });
});

// 与 LoginDto.platform 同理：旧安装包注册时仍带 platform，属性保留、照旧校验、不进文档。
describe('RegisterDto platform (deprecated: accepted and ignored)', () => {
  // 与全局 ValidationPipe 同一组选项（src/setup.ts）。
  const validateLikePipe = (input: Record<string, unknown>) =>
    validate(
      plainToInstance(RegisterDto, input, { enableImplicitConversion: true }),
      { whitelist: true, forbidNonWhitelisted: true },
    );

  it.each([1, 2, 5])(
    'still accepts platform %s from installed app builds',
    async (platform) => {
      expect(
        await validateLikePipe({ ...validPayload, platform }),
      ).toHaveLength(0);
    },
  );

  it('keeps validating the value as before', async () => {
    const errors = await validateLikePipe({ ...validPayload, platform: 3 });
    expect(
      errors.find((error) => error.property === 'platform')?.constraints,
    ).toHaveProperty('isIn');
  });

  it('is no longer documented in the OpenAPI schema', () => {
    const documented: string[] =
      Reflect.getMetadata(
        'swagger/apiModelPropertiesArray',
        RegisterDto.prototype,
      ) ?? [];
    expect(documented).toContain(':nickname');
    expect(documented).not.toContain(':platform');
  });
});
