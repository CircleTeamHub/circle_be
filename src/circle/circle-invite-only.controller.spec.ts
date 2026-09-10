/**
 * 圈子是纯邀请制 —— 不存在「列出/发现全站圈子」的端点。
 *
 * 被删掉的是 `GET /circle`（原 summary: "List circles available to apply for"）。
 * 它的 where 只有 `{ deleted: false }`，既不按成员关系过滤、也不需要邀请上下文，
 * 任何登录用户翻页就能把平台上每个圈子连同圈主 ID、成员数、帖子数、入圈门槛
 * 一起拉走。前端对应的「发现圈子」整条链路已先行移除。
 *
 * 这个 spec 守两件事：那条路由不能回来，以及删它没有误伤同路径的其它动词。
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { CirclePlazaController } from 'src/circle-plaza/circle-plaza.controller';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CircleController } from './circle.controller';
import { CircleService } from './circle.service';

describe('circles are invite-only: no platform-wide listing endpoint', () => {
  let app: INestApplication;
  const circleService = {
    createCircle: jest.fn().mockResolvedValue({}),
    myCircles: jest.fn().mockResolvedValue([]),
  };
  const plazaService = {};

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

  it('GET /circle is gone — a logged-in user cannot enumerate every circle', async () => {
    await request(app.getHttpServer()).get('/circle').expect(404);
  });

  it('paging and city filters cannot resurrect the listing either', async () => {
    await request(app.getHttpServer())
      .get('/circle')
      .query({ page: 1, limit: 100 })
      .expect(404);
    await request(app.getHttpServer())
      .get('/circle')
      .query({ city: 'Tokyo' })
      .expect(404);
  });

  it('keeps POST /circle — same path, different verb, must not be collateral damage', async () => {
    await request(app.getHttpServer())
      .post('/circle')
      .send({
        name: 'Test Circle',
        categories: ['test'],
        description: 'a valid circle description',
      })
      .expect(201);

    expect(circleService.createCircle).toHaveBeenCalled();
  });

  it('keeps GET /circle/my — being invited in still has to show you your circles', async () => {
    await request(app.getHttpServer())
      .get('/circle/my')
      .query({ tab: 'joined' })
      .expect(200);

    expect(circleService.myCircles).toHaveBeenCalled();
  });
});
