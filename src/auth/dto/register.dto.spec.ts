import 'reflect-metadata';
import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  function base(): RegisterDto {
    const dto = new RegisterDto();
    dto.email = 'user@example.com';
    dto.code = '123456';
    dto.password = 'password123';
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
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a non-6-digit code', async () => {
    const dto = base();
    dto.code = '12ab';
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'code')).toBe(true);
  });

  it('rejects a missing nickname', async () => {
    const dto = base();
    dto.nickname = '';
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'nickname')).toBe(true);
  });
});
