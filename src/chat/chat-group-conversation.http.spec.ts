import {
  BadRequestException,
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
 * POST /chat/conversations/group 的 HTTP 管线。全局 ValidationPipe 打回的 400 不带
 * errorCode,所以空名/缺名必须穿过 DTO 到 ChatService,才能以 CHAT_GROUP_NAME_REQUIRED
 * 出现在响应信封里(服务端的判定本身见 chat-group-conversation.spec.ts);
 * 成员 id 形态错误则仍由 DTO 拦下。
 */
describe('POST /chat/conversations/group HTTP pipeline', () => {
  const FRIEND_A = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
  const FRIEND_B = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const FRIEND_A_ALIAS = '2f7c1d9e8b3a4c5d9e1f0a1b2c3d4e5f';
  const ROUTE = '/api/v1/chat/conversations/group';

  let app: INestApplication;
  const chatService = { createGroupConversation: jest.fn() };
  const logger: LoggerService = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };
  const asOwner = {
    canActivate: (context: ExecutionContext) => {
      const req = context
        .switchToHttp()
        .getRequest<{ user?: { userId: string } }>();
      req.user = { userId: 'owner-1' };
      return true;
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    chatService.createGroupConversation.mockResolvedValue({ id: 'conv-1' });

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
      .useValue(asOwner)
      .overrideGuard(AppAudienceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 src/setup.ts 同款的过滤器与管道,信封形状才有意义。
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

  it.each([
    ['a missing name', { memberIds: [FRIEND_A, FRIEND_B] }, undefined],
    ['a blank name', { name: '   ', memberIds: [FRIEND_A, FRIEND_B] }, ''],
    // 旧契约里 name 是 `string | null`;老客户端发 null 也要拿到同一个错误码。
    [
      'an explicit null name',
      { name: null, memberIds: [FRIEND_A, FRIEND_B] },
      undefined,
    ],
  ])(
    'forwards %s to the service so its coded rejection reaches the envelope',
    async (_case, body, forwardedName) => {
      chatService.createGroupConversation.mockRejectedValue(
        new BadRequestException({
          message: '请填写群聊名称',
          errorCode: ChatErrorCode.GroupNameRequired,
        }),
      );

      const response = await request(app.getHttpServer())
        .post(ROUTE)
        .send(body)
        .expect(400);

      expect(chatService.createGroupConversation).toHaveBeenCalledWith(
        'owner-1',
        { name: forwardedName, memberIds: [FRIEND_A, FRIEND_B] },
      );
      expect(response.body).toEqual({
        code: 400,
        message: '请填写群聊名称',
        data: null,
        errorCode: 'CHAT_GROUP_NAME_REQUIRED',
      });
    },
  );

  it('trims the name and forwards 32-hex aliases for the service to normalize', async () => {
    await request(app.getHttpServer())
      .post(ROUTE)
      .send({ name: '  周末爬山  ', memberIds: [FRIEND_A_ALIAS, FRIEND_B] })
      .expect(201);

    expect(chatService.createGroupConversation).toHaveBeenCalledWith(
      'owner-1',
      { name: '周末爬山', memberIds: [FRIEND_A_ALIAS, FRIEND_B] },
    );
  });

  it.each([
    [
      'a slug member id',
      { name: 'x', memberIds: ['openim-tomcoming', FRIEND_B] },
    ],
    ['duplicate member ids', { name: 'x', memberIds: [FRIEND_A, FRIEND_A] }],
    ['a single member', { name: 'x', memberIds: [FRIEND_A] }],
    [
      'a name over 30 characters',
      { name: 'x'.repeat(31), memberIds: [FRIEND_A, FRIEND_B] },
    ],
    [
      'an extra field',
      { name: 'x', memberIds: [FRIEND_A, FRIEND_B], ownerID: 'attacker' },
    ],
  ])('rejects %s in the DTO before the service runs', async (_case, body) => {
    const response = await request(app.getHttpServer())
      .post(ROUTE)
      .send(body)
      .expect(400);

    expect(chatService.createGroupConversation).not.toHaveBeenCalled();
    // DTO 层的 400 没有稳定错误码 —— 这正是群名不能在这一层拒的原因。
    expect(response.body.errorCode).toBeUndefined();
  });
});
