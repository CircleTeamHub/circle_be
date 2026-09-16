import {
  type ExecutionContext,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CallController } from './call.controller';
import { CallService } from './call.service';

/**
 * POST /calls/:callId/leave 的 HTTP 管线。挂断是通话里最不能失败的一步:挂不断的
 * 那一方会把通话卡在 ACTIVE。所以这个路由**不声明 @Body()** —— 全局 ValidationPipe
 * 只校验被装饰器登记过的参数,没有 body 参数就没有 body 校验,
 * forbidNonWhitelisted 也就无从对任何旧客户端多发的字段(历史上的 reason,以及
 * 任何我们没见过的字段)抛 400。结束原因由服务端状态机推导,客户端自报本来就不作数。
 */
describe('POST /calls/:callId/leave HTTP pipeline', () => {
  const CALL_ID = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
  const ROUTE = `/api/v1/calls/${CALL_ID}/leave`;

  let app: INestApplication;
  const callService = { leaveCall: jest.fn() };
  const asCaller = {
    canActivate: (context: ExecutionContext) => {
      const req = context
        .switchToHttp()
        .getRequest<{ user?: { userId: string } }>();
      req.user = { userId: 'user-1' };
      return true;
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    callService.leaveCall.mockResolvedValue({ left: true });

    const moduleRef = await Test.createTestingModule({
      controllers: [CallController],
      providers: [{ provide: CallService, useValue: callService }],
    })
      .overrideGuard(JwtGuard)
      .useValue(asCaller)
      .overrideGuard(AppAudienceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 src/setup.ts 同款的管道,forbidNonWhitelisted 的影响才有意义。
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

  it.each([
    ['an empty body', {}],
    // 已装机的旧版 App 挂断时固定发 { reason: 'NORMAL' }。
    ['the retired reason field', { reason: 'NORMAL' }],
    // 任何我们没登记过的字段都不能把挂断打回 400。
    ['unknown fields', { reason: 'NORMAL', endReason: 'ALL_LEFT', foo: 1 }],
  ])('hangs up with %s', async (_case, body) => {
    await request(app.getHttpServer()).post(ROUTE).send(body).expect(201);

    expect(callService.leaveCall).toHaveBeenCalledWith('user-1', CALL_ID);
  });
});
