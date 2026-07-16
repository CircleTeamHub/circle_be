import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

const validPayload = {
  email: 'user@example.com',
  code: '123456',
  password: 'password1',
  nickname: 'User',
};

describe('RegisterDto inviteCode', () => {
  it('accepts an omitted invite code', async () => {
    const errors = await validate(plainToInstance(RegisterDto, validPayload));
    expect(errors).toHaveLength(0);
  });

  it('trims and lowercases a valid invite code', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...validPayload,
      inviteCode: '  AbC-123  ',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect((dto as RegisterDto & { inviteCode?: string }).inviteCode).toBe(
      'abc-123',
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
    dto.code = '123456';
    dto.password = validPassword;
    dto.nickname = 'Jimmy';
    return dto;
  }

  it('accepts a valid payload', async () => {
    expect(await validate(base())).toHaveLength(0);
  });

  it('rejects an invalid email', async () => {
    const dto = base();
    dto.email = 'not-an-email';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it('rejects a non-6-digit code', async () => {
    const dto = base();
    dto.code = '12ab';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'code')).toBe(true);
  });

  it('rejects a missing nickname', async () => {
    const dto = base();
    dto.nickname = '';
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'nickname')).toBe(true);
  });
});
