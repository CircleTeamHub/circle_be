import { GroupAdmissionService } from './group-admission.service';
import {
  BadRequestException,
  type ExecutionContext,
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import request from 'supertest';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { AllExceptionFilter } from 'src/filters/all-exception.filter';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ChatGroupAdminService } from './chat-group-admin.service';
import { ChatGroupEventService } from './chat-group-event.service';
import { ChatGroupSettingsService } from './chat-group-settings.service';
import { ChatClearRequestService } from './chat-clear-request.service';
import { IdempotencyService } from 'src/idempotency/idempotency.service';
import { RedisService } from 'src/redis/redis.service';
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
  // 幂等层用真实的 IdempotencyService，只把 Redis 换成同语义的内存表。
  const redisStore = new Map<string, string>();
  const memoryRedis = {
    setJsonIfAbsent: async (key: string, value: unknown) => {
      const raw = redisStore.get(key);
      if (raw !== undefined) return { stored: false, current: JSON.parse(raw) };
      redisStore.set(key, JSON.stringify(value));
      return { stored: true };
    },
    setJson: async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
      return true;
    },
    releaseLease: async (key: string, expected: string) => {
      if (redisStore.get(key) === expected) redisStore.delete(key);
    },
  };
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
    redisStore.clear();
    chatService.createGroupConversation.mockResolvedValue({ id: 'conv-1' });

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        {
          provide: GroupAdmissionService,
          useValue: {
            flush: jest.fn().mockResolvedValue(undefined),
            invite: jest.fn(),
          },
        },
        { provide: ChatService, useValue: chatService },
        { provide: ChatGroupAdminService, useValue: {} },
        { provide: ChatGroupEventService, useValue: {} },
        { provide: ChatGroupSettingsService, useValue: {} },
        { provide: ChatClearRequestService, useValue: {} },
        IdempotencyService,
        { provide: RedisService, useValue: memoryRedis },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(asOwner)
      .overrideGuard(AppAudienceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
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

  describe('Idempotency-Key', () => {
    const body = { name: '周末爬山', memberIds: [FRIEND_A, FRIEND_B] };

    it('replays the first 201 and body for a retry instead of creating a second group', async () => {
      chatService.createGroupConversation
        .mockResolvedValueOnce({ id: 'conv-1' })
        .mockResolvedValueOnce({ id: 'conv-2' });

      const first = await request(app.getHttpServer())
        .post(ROUTE)
        .set('Idempotency-Key', 'group-retry-0001')
        .send(body)
        .expect(201);
      const retry = await request(app.getHttpServer())
        .post(ROUTE)
        .set('Idempotency-Key', 'group-retry-0001')
        .send(body)
        .expect(201);

      expect(retry.body).toEqual(first.body);
      expect(first.body).toEqual({ id: 'conv-1' });
      expect(chatService.createGroupConversation).toHaveBeenCalledTimes(1);
    });

    it('keeps creating on every call when the header is absent (old clients)', async () => {
      await request(app.getHttpServer()).post(ROUTE).send(body).expect(201);
      await request(app.getHttpServer()).post(ROUTE).send(body).expect(201);

      expect(chatService.createGroupConversation).toHaveBeenCalledTimes(2);
    });

    it('answers 409 IDEMPOTENCY_KEY_REUSED when the key comes back with another body', async () => {
      await request(app.getHttpServer())
        .post(ROUTE)
        .set('Idempotency-Key', 'group-retry-0001')
        .send(body)
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(ROUTE)
        .set('Idempotency-Key', 'group-retry-0001')
        .send({ ...body, name: '另一个群' })
        .expect(409);

      expect(response.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(chatService.createGroupConversation).toHaveBeenCalledTimes(1);
    });

    it('answers 400 IDEMPOTENCY_KEY_INVALID for a malformed key', async () => {
      const response = await request(app.getHttpServer())
        .post(ROUTE)
        .set('Idempotency-Key', 'bad key!')
        .send(body)
        .expect(400);

      expect(response.body.errorCode).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(chatService.createGroupConversation).not.toHaveBeenCalled();
    });
  });
});
