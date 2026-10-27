import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { deriveDeclineTokenKey, issueDeclineToken } from './call-decline-token';
import { CallPushController } from './call-push.controller';
import { CallPushService } from './call-push.service';
import { CallService } from './call.service';

/**
 * POST /calls/:callId/push-decline：锁屏上点拒接时原生层凭推送里的单通令牌调用，
 * 不带登录态。成功与「早就不在振铃了」都回 204，令牌不对回 401。
 */
describe('POST /calls/:callId/push-decline HTTP pipeline', () => {
  const CALL_ID = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
  const USER_ID = '7d0f4a52-2c1b-4b8e-9a3e-5f6a7b8c9d0e';
  const ROUTE = `/api/v1/calls/${CALL_ID}/push-decline`;
  const key = deriveDeclineTokenKey('http-spec-secret');
  const ringExpiresAt = () => new Date(Date.now() + 30_000);

  let app: INestApplication;
  const callService = { declineFromPush: jest.fn() };
  const callPush = { getDeclineKey: () => key };

  beforeEach(async () => {
    jest.clearAllMocks();
    callService.declineFromPush.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [CallPushController],
      providers: [
        { provide: CallService, useValue: callService },
        { provide: CallPushService, useValue: callPush },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('declines on behalf of the user the token was issued to', async () => {
    const token = issueDeclineToken(key, CALL_ID, USER_ID, ringExpiresAt());

    await request(app.getHttpServer()).post(ROUTE).send({ token }).expect(204);

    expect(callService.declineFromPush).toHaveBeenCalledWith(USER_ID, CALL_ID);
  });

  it('rejects a token issued for another call', async () => {
    const token = issueDeclineToken(
      key,
      '00000000-0000-4000-8000-000000000000',
      USER_ID,
      ringExpiresAt(),
    );

    await request(app.getHttpServer()).post(ROUTE).send({ token }).expect(401);
    expect(callService.declineFromPush).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const token = issueDeclineToken(
      key,
      CALL_ID,
      USER_ID,
      new Date(Date.now() - 10 * 60_000),
    );

    await request(app.getHttpServer()).post(ROUTE).send({ token }).expect(401);
    expect(callService.declineFromPush).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', undefined],
    ['a malformed token', { token: 'not a token' }],
    ['extra fields', { token: 'v1.abc.1.x', userId: USER_ID }],
  ])('returns 400 for %s', async (_case, body) => {
    await request(app.getHttpServer()).post(ROUTE).send(body).expect(400);
    expect(callService.declineFromPush).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid call id', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/calls/not-a-uuid/push-decline')
      .send({ token: 'v1.abc.1.x' })
      .expect(400);
  });
});
