import 'reflect-metadata';
import { validate } from 'class-validator';
import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  it('allows nickname to be omitted', async () => {
    const dto = new RegisterDto();
    dto.accountId = 'testuser';
    dto.password = 'password123';

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
