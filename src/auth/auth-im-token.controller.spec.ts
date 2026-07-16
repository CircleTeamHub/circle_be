import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController, IM_TOKEN_RATE_LIMIT } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './auth.strategy';
import { SessionRevocationService } from './session-revocation.service';

const TEST_SECRET = 'im-token-spec-secret';
const IM_TOKEN_ROUTE = '/auth/im-token';

/**
 * GET /auth/im-token mints an OpenIM token for the caller. It is the only
 * route that can hand out an IM credential outside of login, so these tests
 * pin down the two properties that make it safe:
 *   1. the real JwtGuard rejects unauthenticated callers (no token minted), and
 *   2. identity comes from the JWT alone — no request input can redirect it.
 *
 * The real JwtStrategy is wired up on purpose (rather than overriding the
 * guard) so the 401 below is proof of the guard actually running, not of a
 * stub returning false.
 */
describe('AuthController GET /auth/im-token', () => {
  let app: INestApplication;
  let jwt: JwtService;

  const authService = {
    getImToken: jest.fn(),
  };

  const signToken = (payload: Record<string, unknown>) =>
    jwt.sign(payload, { secret: TEST_SECRET, expiresIn: '5m' });

  beforeEach(async () => {
    authService.getImToken.mockReset();
    authService.getImToken.mockResolvedValue({ imToken: 'im-token-xyz' });

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        JwtStrategy,
        JwtService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'SECRET' ? TEST_SECRET : undefined),
          },
        },
        {
          provide: SessionRevocationService,
          useValue: { isRevoked: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    jwt = app.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  // ─── Guard proof ───────────────────────────────────────────────────────────

  it('rejects an unauthenticated request with 401 and mints nothing', async () => {
    await request(app.getHttpServer()).get(IM_TOKEN_ROUTE).expect(401);

    expect(authService.getImToken).not.toHaveBeenCalled();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: 'attacker' }, { secret: 'not-the-secret' });

    await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);

    expect(authService.getImToken).not.toHaveBeenCalled();
  });

  it('rejects an admin-audience token', async () => {
    // adminLogin issues its tokens with issueImToken:false — an admin web
    // session deliberately carries no IM capability. Minting one here would
    // hand back exactly what admin login withheld.
    const adminToken = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'admin',
      aud: 'ADMIN',
    });

    await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);

    expect(authService.getImToken).not.toHaveBeenCalled();
  });

  // ─── Identity is JWT-derived only ──────────────────────────────────────────

  it('returns the IM token for the JWT subject', async () => {
    const token = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'user',
    });

    const res = await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({ imToken: 'im-token-xyz' });
    expect(authService.getImToken).toHaveBeenCalledWith('user-1', undefined);
  });

  it('cannot be steered to another user via a query param', async () => {
    const token = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'user',
    });

    await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .query({ userId: 'victim' })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(authService.getImToken).not.toHaveBeenCalled();
  });

  it('cannot be steered to another user via a request body', async () => {
    const token = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'user',
    });

    await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'victim' })
      .expect(200);

    // The body is never read; identity stays the JWT subject.
    expect(authService.getImToken).toHaveBeenCalledWith('user-1', undefined);
  });

  it('passes the caller platform through so the token targets the right slot', async () => {
    const token = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'user',
    });

    await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .query({ platform: 1 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(authService.getImToken).toHaveBeenCalledWith('user-1', 1);
  });

  it('rejects an out-of-range platform', async () => {
    const token = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'user',
    });

    await request(app.getHttpServer())
      .get(IM_TOKEN_ROUTE)
      .query({ platform: 99 })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(authService.getImToken).not.toHaveBeenCalled();
  });

  // ─── Amplification guard ───────────────────────────────────────────────────

  it('rate-limits the caller, since every call hits OpenIM', async () => {
    const token = signToken({
      sub: 'user-1',
      accountId: 'acct-1',
      role: 'user',
    });
    const send = () =>
      request(app.getHttpServer())
        .get(IM_TOKEN_ROUTE)
        .set('Authorization', `Bearer ${token}`);

    const statuses: number[] = [];
    for (let i = 0; i < IM_TOKEN_RATE_LIMIT + 2; i += 1) {
      statuses.push((await send()).status);
    }

    expect(statuses.slice(0, IM_TOKEN_RATE_LIMIT)).toEqual(
      Array(IM_TOKEN_RATE_LIMIT).fill(200),
    );
    expect(statuses.slice(IM_TOKEN_RATE_LIMIT)).toEqual([429, 429]);
    // The throttled calls must never have reached OpenIM.
    expect(authService.getImToken).toHaveBeenCalledTimes(IM_TOKEN_RATE_LIMIT);
  });
});
