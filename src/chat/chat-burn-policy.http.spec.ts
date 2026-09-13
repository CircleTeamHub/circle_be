import {
  ForbiddenException,
  type ExecutionContext,
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { AllExceptionFilter } from 'src/filters/all-exception.filter';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ChatGroupAdminService } from './chat-group-admin.service';
import { ChatGroupEventService } from './chat-group-event.service';
import { ChatGroupSettingsService } from './chat-group-settings.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * /chat/conversations/:id/burn 的 HTTP 管线。
 *
 * 已装机的 App 每次打开私聊都会 GET 这个路径(chat-core fetchChatBurnPolicy),
 * 而此前服务端只有 POST —— 每开一次聊天就是一个 404。GET 与 POST 同路径并存,
 * 两个方法都要各自落到对应的 service 方法上。
 */
describe('/chat/conversations/:id/burn HTTP pipeline', () => {
  const CONVERSATION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const ROUTE = `/api/v1/chat/conversations/${CONVERSATION_ID}/burn`;

  let app: INestApplication;
  const chatService = {
    getBurnPolicy: jest.fn(),
    setBurnDuration: jest.fn(),
  };
  const logger: LoggerService = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };
  const asMember = {
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

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: ChatGroupAdminService, useValue: {} },
        { provide: ChatGroupEventService, useValue: {} },
        { provide: ChatGroupSettingsService, useValue: {} },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(asMember)
      .overrideGuard(AppAudienceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(
      new AllExceptionFilter(logger, app.get(HttpAdapterHost)),
    );
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

  it('GET reads the caller-scoped policy from the service', async () => {
    chatService.getBurnPolicy.mockResolvedValue({ burnDurationSec: 3600 });

    const response = await request(app.getHttpServer()).get(ROUTE).expect(200);

    expect(chatService.getBurnPolicy).toHaveBeenCalledWith(
      'user-1',
      CONVERSATION_ID,
    );
    expect(response.body).toEqual({ burnDurationSec: 3600 });
  });

  it('GET rejects a non-uuid conversation id before reaching the service', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/chat/conversations/not-a-uuid/burn')
      .expect(400);

    expect(chatService.getBurnPolicy).not.toHaveBeenCalled();
  });

  it('GET surfaces the membership rejection with its error code', async () => {
    chatService.getBurnPolicy.mockRejectedValue(
      new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      }),
    );

    const response = await request(app.getHttpServer()).get(ROUTE).expect(403);

    expect(response.body).toMatchObject({ errorCode: 'CHAT_NOT_MEMBER' });
  });

  it('POST on the same path still changes the policy', async () => {
    chatService.setBurnDuration.mockResolvedValue({ burnDurationSec: 60 });

    await request(app.getHttpServer())
      .post(ROUTE)
      .send({ seconds: 60 })
      .expect(201);

    expect(chatService.setBurnDuration).toHaveBeenCalledWith(
      'user-1',
      CONVERSATION_ID,
      60,
    );
    expect(chatService.getBurnPolicy).not.toHaveBeenCalled();
  });

  it('GET carries the same read throttle budget as the sibling per-conversation reads', () => {
    const handler = ChatController.prototype.getBurnPolicy;

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(60);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});
