import { createHash } from 'crypto';
import {
  ConflictException,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { ResponseInterceptor } from 'src/interceptors/response.interceptor';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DeviceTrustService } from './device-trust.service';
import { RefreshTokenService } from './refresh-token.service';
import { SecurityQuestionsService } from './security-questions.service';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const OLD_REFRESH = 'a'.repeat(128);
const NEW_REFRESH = 'b'.repeat(128);
const CHALLENGE_ID = '10000000-0000-4000-8000-000000000001';
const KNOWN_DEVICE = 'web-device-0123456789abcdef';
const ISSUED = { accessToken: 'access-token', refreshToken: NEW_REFRESH };

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Set-Cookie lines of a response, keyed by cookie name. */
function setCookies(res: request.Response): Record<string, string> {
  const lines = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  return Object.fromEntries(lines.map((line) => [line.split('=')[0], line]));
}

const cookieValue = (line: string) => line.split(';')[0].split('=')[1];

describe('Auth web session cookies (HTTP)', () => {
  let app: INestApplication;
  const auth = {
    register: jest.fn(),
    login: jest.fn(),
    verifyLoginChallengeCode: jest.fn(),
    verifyLoginChallengeSecurityCode: jest.fn(),
    verifyLoginChallengeSecurityQuestions: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  };
  const deviceTrust = { status: jest.fn() };

  const contextOf = (mock: jest.Mock, argIndex: number) =>
    mock.mock.calls[0][argIndex] as { deviceKey?: string | null };

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const issue of [
      auth.register,
      auth.login,
      auth.verifyLoginChallengeCode,
      auth.verifyLoginChallengeSecurityCode,
      auth.verifyLoginChallengeSecurityQuestions,
      auth.refresh,
    ])
      issue.mockResolvedValue(ISSUED);
    auth.logout.mockResolvedValue(undefined);
    deviceTrust.status.mockResolvedValue({ status: 'pending' });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: DeviceTrustService, useValue: deviceTrust },
        { provide: SecurityQuestionsService, useValue: {} },
        {
          provide: RefreshTokenService,
          useValue: {
            findSessionDeviceKey: jest.fn(),
            ttlMsFor: () => SEVEN_DAYS_MS,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const login = () =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'user@example.com', password: 'password1' });

  describe('login', () => {
    it('moves the refresh token into an HttpOnly cookie and issues a device cookie', async () => {
      const res = await login().set('X-Web-Session', '1').expect(201);

      expect(res.body.data).toEqual({ accessToken: 'access-token' });
      expect(JSON.stringify(res.body)).not.toContain(NEW_REFRESH);

      const cookies = setCookies(res);
      expect(cookieValue(cookies.circle_rt)).toBe(NEW_REFRESH);
      expect(cookies.circle_rt).toContain('Path=/api/v1/auth');
      expect(cookies.circle_rt).toContain(`Max-Age=${SEVEN_DAYS_MS / 1000}`);
      expect(cookies.circle_rt).toContain('HttpOnly');
      expect(cookies.circle_rt).toContain('SameSite=Strict');
      // jest 跑在 NODE_ENV=test：本地 http 开发也要能用，所以不带 Secure。
      expect(cookies.circle_rt).not.toContain('Secure');

      const deviceId = cookieValue(cookies.circle_did);
      expect(deviceId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookies.circle_did).toContain('Path=/api/v1;');
      expect(cookies.circle_did).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
      expect(cookies.circle_did).toContain('HttpOnly');
      expect(cookies.circle_did).toContain('SameSite=Strict');
      expect(contextOf(auth.login, 1).deviceKey).toBe(sha256(deviceId));
    });

    it('marks both cookies Secure in production', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await login().set('X-Web-Session', '1').expect(201);
        const cookies = setCookies(res);
        expect(cookies.circle_rt).toContain('Secure');
        expect(cookies.circle_did).toContain('Secure');
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('leaves native logins unchanged', async () => {
      const res = await login()
        .set('X-Device-Id', KNOWN_DEVICE)
        .set('Cookie', `circle_did=other-device-0123456789`)
        .expect(201);

      expect(res.body.data).toEqual(ISSUED);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(contextOf(auth.login, 1).deviceKey).toBe(sha256(KNOWN_DEVICE));
    });

    it('reuses a valid device cookie and ignores X-Device-Id', async () => {
      const res = await login()
        .set('X-Web-Session', '1')
        .set('X-Device-Id', 'header-device-0123456789')
        .set('Cookie', `circle_did=${KNOWN_DEVICE}`)
        .expect(201);

      expect(setCookies(res).circle_did).toBeUndefined();
      expect(contextOf(auth.login, 1).deviceKey).toBe(sha256(KNOWN_DEVICE));
    });

    it('replaces an invalid device cookie', async () => {
      const res = await login()
        .set('X-Web-Session', '1')
        .set('Cookie', 'circle_did=bad!')
        .expect(201);

      const deviceId = cookieValue(setCookies(res).circle_did);
      expect(deviceId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(contextOf(auth.login, 1).deviceKey).toBe(sha256(deviceId));
    });

    it('passes a device-verification result through but still pins the device', async () => {
      const challenge = {
        deviceVerificationRequired: true,
        challenge: { id: CHALLENGE_ID, securityCodeAvailable: false },
      };
      auth.login.mockResolvedValueOnce(challenge);

      const res = await login().set('X-Web-Session', '1').expect(201);

      expect(res.body.data).toEqual(challenge);
      const cookies = setCookies(res);
      expect(cookies.circle_rt).toBeUndefined();
      expect(contextOf(auth.login, 1).deviceKey).toBe(
        sha256(cookieValue(cookies.circle_did)),
      );
    });
  });

  it.each([
    [
      'register',
      '/api/v1/auth/register',
      {
        email: 'user@example.com',
        password: 'password1',
        confirmPassword: 'password1',
        nickname: 'Web',
      },
      'register',
      1,
    ],
    [
      'trusted-device code',
      `/api/v1/auth/login-challenges/${CHALLENGE_ID}/verify`,
      { code: '123456' },
      'verifyLoginChallengeCode',
      2,
    ],
    [
      'security code',
      `/api/v1/auth/login-challenges/${CHALLENGE_ID}/security-code`,
      { securityCode: '1234' },
      'verifyLoginChallengeSecurityCode',
      2,
    ],
    [
      'security questions',
      `/api/v1/auth/login-challenges/${CHALLENGE_ID}/security-questions`,
      { answers: ['one', 'two'] },
      'verifyLoginChallengeSecurityQuestions',
      2,
    ],
  ] as const)(
    '%s sets the refresh cookie in web mode',
    async (_label, path, body, method, contextArg) => {
      const res = await request(app.getHttpServer())
        .post(path)
        .set('X-Web-Session', '1')
        .set('Cookie', `circle_did=${KNOWN_DEVICE}`)
        .send(body)
        .expect(201);

      expect(res.body.data).toEqual({ accessToken: 'access-token' });
      expect(cookieValue(setCookies(res).circle_rt)).toBe(NEW_REFRESH);
      expect(contextOf(auth[method], contextArg).deviceKey).toBe(
        sha256(KNOWN_DEVICE),
      );
    },
  );

  it('read-only challenge routes read the device cookie but never issue one', async () => {
    const status = (cookie?: string) => {
      const req = request(app.getHttpServer())
        .get(`/api/v1/auth/login-challenges/${CHALLENGE_ID}/status`)
        .set('X-Web-Session', '1');
      return cookie ? req.set('Cookie', cookie) : req;
    };

    const known = await status(`circle_did=${KNOWN_DEVICE}`).expect(200);
    const missing = await status().expect(200);

    expect(deviceTrust.status.mock.calls).toEqual([
      [CHALLENGE_ID, sha256(KNOWN_DEVICE)],
      [CHALLENGE_ID, null],
    ]);
    expect(known.headers['set-cookie']).toBeUndefined();
    expect(missing.headers['set-cookie']).toBeUndefined();
  });

  describe('refresh', () => {
    const refresh = () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('X-Web-Session', '1');

    it('rotates the cookie token and returns only the access token', async () => {
      const attempt = '11111111-1111-4111-8111-111111111111';
      const res = await refresh()
        .set('Cookie', `circle_rt=${OLD_REFRESH}; circle_did=${KNOWN_DEVICE}`)
        .set('Idempotency-Key', attempt)
        .send({})
        .expect(201);

      expect(auth.refresh).toHaveBeenCalledWith(
        OLD_REFRESH,
        expect.objectContaining({
          deviceKey: sha256(KNOWN_DEVICE),
          rotationAttemptId: attempt,
        }),
      );
      expect(res.body.data).toEqual({ accessToken: 'access-token' });
      const cookies = setCookies(res);
      expect(cookieValue(cookies.circle_rt)).toBe(NEW_REFRESH);
      expect(cookies.circle_rt).toContain('Path=/api/v1/auth');
      expect(cookies.circle_did).toBeUndefined();
    });

    it('answers 401 and clears the refresh cookie when there is none', async () => {
      const res = await refresh()
        .set('Cookie', `circle_did=${KNOWN_DEVICE}`)
        .send({})
        .expect(401);

      expect(res.body.message).toBe('Invalid or expired refresh token');
      expect(auth.refresh).not.toHaveBeenCalled();
      const cookies = setCookies(res);
      expect(cookieValue(cookies.circle_rt)).toBe('');
      expect(cookies.circle_rt).toContain('Path=/api/v1/auth');
      expect(cookies.circle_rt).toContain('Expires=Thu, 01 Jan 1970');
      expect(cookies.circle_rt).toContain('HttpOnly');
      expect(cookies.circle_rt).toContain('SameSite=Strict');
      expect(cookies.circle_did).toBeUndefined();
    });

    it('clears the refresh cookie when the service rejects the token', async () => {
      auth.refresh.mockRejectedValueOnce(
        new UnauthorizedException('Invalid or expired refresh token'),
      );

      const res = await refresh()
        .set('Cookie', `circle_rt=${OLD_REFRESH}; circle_did=${KNOWN_DEVICE}`)
        .send({})
        .expect(401);

      const cookies = setCookies(res);
      expect(cookieValue(cookies.circle_rt)).toBe('');
      expect(cookies.circle_did).toBeUndefined();
    });

    it('keeps the cookie on a superseded (409) attempt', async () => {
      auth.refresh.mockRejectedValueOnce(
        new ConflictException('Superseded by a newer refresh attempt'),
      );

      const res = await refresh()
        .set('Cookie', `circle_rt=${OLD_REFRESH}; circle_did=${KNOWN_DEVICE}`)
        .send({})
        .expect(409);

      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('ignores the cookie without X-Web-Session', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', `circle_rt=${OLD_REFRESH}`)
        .send({})
        .expect(400);

      expect(auth.refresh).not.toHaveBeenCalled();
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('keeps the native body-token contract', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('X-Device-Id', KNOWN_DEVICE)
        .send({ refreshToken: OLD_REFRESH })
        .expect(201);

      expect(auth.refresh).toHaveBeenCalledWith(
        OLD_REFRESH,
        expect.objectContaining({ deviceKey: sha256(KNOWN_DEVICE) }),
      );
      expect(res.body.data).toEqual(ISSUED);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('still validates a native body token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'short' })
        .expect(400);

      expect(auth.refresh).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the cookie token and clears only the refresh cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('X-Web-Session', '1')
        .set('Cookie', `circle_rt=${OLD_REFRESH}; circle_did=${KNOWN_DEVICE}`)
        .send({})
        .expect(201);

      expect(auth.logout).toHaveBeenCalledWith(
        OLD_REFRESH,
        expect.objectContaining({ deviceKey: sha256(KNOWN_DEVICE) }),
      );
      const cookies = setCookies(res);
      expect(cookieValue(cookies.circle_rt)).toBe('');
      expect(cookies.circle_rt).toContain('Path=/api/v1/auth');
      expect(cookies.circle_did).toBeUndefined();
    });

    it('clears the refresh cookie even when it is already gone', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('X-Web-Session', '1')
        .send({})
        .expect(201);

      expect(auth.logout).not.toHaveBeenCalled();
      expect(cookieValue(setCookies(res).circle_rt)).toBe('');
    });

    it('keeps the native body-token contract', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: OLD_REFRESH })
        .expect(201);

      expect(auth.logout).toHaveBeenCalledWith(OLD_REFRESH, expect.any(Object));
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a native logout without a body token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', `circle_rt=${OLD_REFRESH}`)
        .send({})
        .expect(400);

      expect(auth.logout).not.toHaveBeenCalled();
    });
  });
});
