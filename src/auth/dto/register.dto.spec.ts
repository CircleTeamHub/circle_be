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

// 与 LoginDto.platform 同理：旧安装包注册时也带 platform，服务端从来不读，属性整个删掉。
// 同样是明确的破坏性变更 —— forbidNonWhitelisted 会把仍在发它的旧安装包注册拒成 400。
describe('RegisterDto no longer accepts platform', () => {
  // 与全局 ValidationPipe 同一组选项（src/setup.ts）。
  const validateLikePipe = (input: Record<string, unknown>) =>
    validate(
      plainToInstance(RegisterDto, input, { enableImplicitConversion: true }),
      { whitelist: true, forbidNonWhitelisted: true },
    );

  it.each([1, 2, 5])(
    'rejects platform %s as an unknown property',
    async (platform) => {
      const errors = await validateLikePipe({ ...validPayload, platform });

      expect(
        errors.find((error) => error.property === 'platform')?.constraints,
      ).toHaveProperty('whitelistValidation');
    },
  );

  it('accepts the payload current clients send', async () => {
    expect(await validateLikePipe(validPayload)).toHaveLength(0);
  });
});
