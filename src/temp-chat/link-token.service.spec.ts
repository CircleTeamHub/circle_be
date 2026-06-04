import { JwtService } from '@nestjs/jwt';
import { LinkTokenService } from './link-token.service';

describe('LinkTokenService', () => {
  const jwt = new JwtService({ secret: 'test-link-secret' });
  const service = new LinkTokenService(jwt);

  it('signs and verifies a tcId round-trip', () => {
    const token = service.sign('tc-1', 3600);
    expect(service.verify(token)).toEqual({ tcId: 'tc-1' });
  });

  it('throws on tampered token', () => {
    const token = service.sign('tc-1', 3600);
    expect(() => service.verify(token + 'x')).toThrow();
  });

  it('throws on expired token', () => {
    const token = service.sign('tc-1', -1); // already expired
    expect(() => service.verify(token)).toThrow();
  });
});
