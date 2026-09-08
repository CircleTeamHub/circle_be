import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

async function errorsFor(input: Record<string, unknown>) {
  return validate(plainToInstance(LoginDto, input));
}

describe('LoginDto identifier compatibility', () => {
  it('still validates identifier when the deprecated email alias is also present', async () => {
    const errors = await errorsFor({
      identifier: 42,
      email: 'user@example.com',
      password: 'password1',
    });

    expect(errors.some((error) => error.property === 'identifier')).toBe(true);
  });
});
