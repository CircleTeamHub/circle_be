import { instanceToPlain, plainToInstance } from 'class-transformer';
import { AuthSessionDto } from './auth-session.dto';

test('serialized device records expose the persistent trust discriminator', () => {
  const row = plainToInstance(
    AuthSessionDto,
    { id: 'trusted-record', trustedOnly: true },
    { excludeExtraneousValues: true },
  );
  expect(instanceToPlain(row, { excludeExtraneousValues: true })).toMatchObject(
    { id: 'trusted-record', trustedOnly: true },
  );
});
