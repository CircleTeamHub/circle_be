import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { CirclePlazaController } from 'src/circle-plaza/circle-plaza.controller';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CircleController } from './circle.controller';
import { CircleService } from './circle.service';

describe('VIP restriction controller validation', () => {
  let app: INestApplication;
  const circleService = { createCircle: jest.fn().mockResolvedValue({}) };
  const plazaService = { createPost: jest.fn().mockResolvedValue({}) };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [CircleController, CirclePlazaController],
      providers: [
        { provide: CircleService, useValue: circleService },
        { provide: CirclePlazaService, useValue: plazaService },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

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
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects circle join VIP restrictions above 4 before the service', async () => {
    await request(app.getHttpServer())
      .post('/circle')
      .send({
        name: 'Test Circle',
        categories: ['test'],
        description: 'a valid circle description',
        joinVipRestriction: 5,
      })
      .expect(400);

    expect(circleService.createCircle).not.toHaveBeenCalled();
  });

  it('preserves legacy circle restriction zero for service normalization', async () => {
    await request(app.getHttpServer())
      .post('/circle')
      .send({
        name: 'Test Circle',
        categories: ['test'],
        description: 'a valid circle description',
        joinVipRestriction: 0,
      })
      .expect(201);

    expect(circleService.createCircle).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ joinVipRestriction: 0 }),
    );
  });

  it('accepts the super membership circle capacity boundary', async () => {
    await request(app.getHttpServer())
      .post('/circle')
      .send({
        name: 'Test Circle',
        categories: ['test'],
        description: 'a valid circle description',
        maxMembers: 3000,
      })
      .expect(201);

    expect(circleService.createCircle).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ maxMembers: 3000 }),
    );
  });

  it('rejects maxMembers above the highest membership capacity', async () => {
    await request(app.getHttpServer())
      .post('/circle')
      .send({
        name: 'Test Circle',
        categories: ['test'],
        description: 'a valid circle description',
        maxMembers: 3001,
      })
      .expect(400);

    expect(circleService.createCircle).not.toHaveBeenCalled();
  });

  it.each(['vipRestriction', 'signupVipRestriction'] as const)(
    'rejects plaza %s above 4 before the service',
    async (property) => {
      await request(app.getHttpServer())
        .post('/circle-plaza/posts')
        .send({
          content: 'hello plaza',
          circleId: '07b8cd30-afdf-4b74-8dfe-6dd5b422364b',
          [property]: 5,
        })
        .expect(400);

      expect(plazaService.createPost).not.toHaveBeenCalled();
    },
  );

  it('preserves legacy plaza restriction zeros for service normalization', async () => {
    await request(app.getHttpServer())
      .post('/circle-plaza/posts')
      .send({
        content: 'hello plaza',
        circleId: '07b8cd30-afdf-4b74-8dfe-6dd5b422364b',
        vipRestriction: 0,
        signupVipRestriction: 0,
      })
      .expect(201);

    expect(plazaService.createPost).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        vipRestriction: 0,
        signupVipRestriction: 0,
      }),
    );
  });
});
