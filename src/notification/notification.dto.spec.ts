import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterPushTokenDto, RevokePushTokenDto } from './notification.dto';

describe('push token DTOs', () => {
  const registration = (overrides: Record<string, unknown> = {}) =>
    plainToInstance(RegisterPushTokenDto, {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
      provider: 'expo',
      ...overrides,
    });

  it('keeps revocation secrets optional for legacy registration clients', () => {
    expect(validateSync(registration())).toHaveLength(0);
  });

  it('accepts registration revocation secrets from 32 through 256 characters', () => {
    expect(
      validateSync(registration({ revocationSecret: 'a'.repeat(32) })),
    ).toHaveLength(0);
    expect(
      validateSync(registration({ revocationSecret: 'b'.repeat(256) })),
    ).toHaveLength(0);
  });

  it('rejects registration revocation secrets outside the length bounds', () => {
    for (const revocationSecret of ['a'.repeat(31), 'b'.repeat(257)]) {
      expect(
        validateSync(registration({ revocationSecret })).map(
          (error) => error.property,
        ),
      ).toContain('revocationSecret');
    }
  });

  it('requires a bounded token and revocation secret for public revocation', () => {
    const valid = plainToInstance(RevokePushTokenDto, {
      token: 'ExponentPushToken[abc]',
      revocationSecret: 's'.repeat(32),
    });
    expect(validateSync(valid)).toHaveLength(0);

    const missing = plainToInstance(RevokePushTokenDto, {});
    expect(
      validateSync(missing)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['revocationSecret', 'token']);

    const invalid = plainToInstance(RevokePushTokenDto, {
      token: 't'.repeat(513),
      revocationSecret: 's'.repeat(31),
    });
    expect(
      validateSync(invalid)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['revocationSecret', 'token']);
  });
});
