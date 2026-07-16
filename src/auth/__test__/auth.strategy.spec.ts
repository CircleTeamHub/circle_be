import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from '../auth.strategy';
import type { SessionRevocationService } from '../session-revocation.service';

describe('JwtStrategy', () => {
  const config = {
    get: jest.fn(() => 'test-secret'),
  } as unknown as ConfigService;

  const payload = {
    sub: 'user-1',
    accountId: 'admin',
    role: 'ADMIN' as const,
    sid: 'session-1',
    aud: 'ADMIN' as const,
  };

  it('maps token audience onto the authenticated request user', async () => {
    const revocation = {
      isRevoked: jest.fn().mockResolvedValue(false),
    } as unknown as SessionRevocationService;
    const strategy = new JwtStrategy(config, revocation);

    await expect(strategy.validate(payload)).resolves.toEqual({
      userId: 'user-1',
      accountId: 'admin',
      role: 'ADMIN',
      sessionId: 'session-1',
      audience: 'ADMIN',
    });
  });

  it('rejects a revoked session (F-02)', async () => {
    const revocation = {
      isRevoked: jest.fn().mockResolvedValue(true),
    } as unknown as SessionRevocationService;
    const strategy = new JwtStrategy(config, revocation);

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
