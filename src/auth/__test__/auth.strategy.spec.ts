import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from '../auth.strategy';

describe('JwtStrategy', () => {
  it('maps token audience onto the authenticated request user', () => {
    const strategy = new JwtStrategy({
      get: jest.fn(() => 'test-secret'),
    } as unknown as ConfigService);

    expect(
      strategy.validate({
        sub: 'user-1',
        accountId: 'admin',
        role: 'ADMIN',
        sid: 'session-1',
        aud: 'ADMIN',
      }),
    ).toEqual({
      userId: 'user-1',
      accountId: 'admin',
      role: 'ADMIN',
      sessionId: 'session-1',
      audience: 'ADMIN',
    });
  });
});
