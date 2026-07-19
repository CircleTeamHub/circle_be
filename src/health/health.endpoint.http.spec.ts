import {
  Controller,
  Get,
  INestApplication,
  Logger,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ResponseInterceptor } from 'src/interceptors/response.interceptor';
import {
  createLivenessHandler,
  createReadinessHandler,
  type HealthDatabase,
} from './health.endpoint';

/** A guarded, prefixed, envelope-wrapped route — i.e. what every real route is. */
@UseGuards(JwtGuard)
@Controller('outbox')
class ProbeNeighbourController {
  @Get()
  find() {
    return { secret: true };
  }
}

/**
 * Mounts the probes exactly as setup.ts does — on the Express instance ahead of
 * the rate limiter, alongside a global prefix, guards and the JSON envelope —
 * and asserts they stay outside all of it.
 */
describe('health probes in the real HTTP pipeline', () => {
  let app: INestApplication;
  const queryRaw = jest.fn();
  const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

  afterAll(() => errorSpy.mockRestore());

  async function bootstrap(limiterMax = 100): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeNeighbourController],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: () => {
          throw new UnauthorizedException();
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');

    const database = { $queryRaw: queryRaw } as unknown as HealthDatabase;
    app.use('/healthz', createLivenessHandler());
    app.use('/readyz', createReadinessHandler({ database, redis: null }));

    app.use(rateLimit({ windowMs: 60_000, max: limiterMax }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    return app;
  }

  beforeEach(() => {
    queryRaw.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  });

  afterEach(async () => {
    await app?.close();
  });

  it('serves /healthz unauthenticated, unprefixed and unwrapped', async () => {
    await bootstrap();

    // Same app, same pipeline: a normal route is 401 behind the guard...
    await request(app.getHttpServer()).get('/api/v1/outbox').expect(401);

    // ...while the probe answers 200, with no api/v1 prefix and no envelope.
    const response = await request(app.getHttpServer())
      .get('/healthz')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('serves /readyz with the real database check', async () => {
    await bootstrap();

    const response = await request(app.getHttpServer())
      .get('/readyz')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      database: 'up',
      redis: 'disabled',
      objectStore: 'disabled',
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('answers /readyz with 503 while the database is unreachable', async () => {
    await bootstrap();
    queryRaw.mockRejectedValue(new Error('Connection terminated'));

    const response = await request(app.getHttpServer())
      .get('/readyz')
      .expect(503);

    expect(response.body).toEqual({
      status: 'error',
      database: 'down',
      redis: 'disabled',
      objectStore: 'disabled',
    });
  });

  it('keeps answering probes after the rate limiter is exhausted', async () => {
    await bootstrap(1);

    // Burn the single allowance, so any probe reaching the limiter would 429.
    await request(app.getHttpServer()).get('/api/v1/outbox').expect(401);
    await request(app.getHttpServer()).get('/api/v1/outbox').expect(429);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app.getHttpServer()).get('/healthz').expect(200);
      await request(app.getHttpServer()).get('/readyz').expect(200);
    }
  });
});
