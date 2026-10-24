import {
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { AllExceptionFilter } from 'src/filters/all-exception.filter';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { ChatGroupAdminService } from './chat-group-admin.service';
import { ChatGroupEventService } from './chat-group-event.service';
import { ChatGroupSettingsService } from './chat-group-settings.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { GroupAdmissionService } from './group-admission.service';

/**
 * GET /chat/conversations 的 HTTP 管线：真实的查询串解析 + 全局 ValidationPipe +
 * 异常信封。两种模式由 cursor 是否出现决定：
 * - 不带 cursor：旧的活跃度排序（已装机 App 永远不带），只有 X-Has-More；
 * - 带 cursor（`?cursor=` 空串 = 从头开始）：按 conversationID 升序的键集分页，
 *   还有下一页时多一个 X-Next-Cursor。
 */
describe('GET /chat/conversations HTTP pipeline', () => {
  const ROUTE = '/api/v1/chat/conversations';
  const LAST_ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';

  let app: INestApplication;
  const chatService = {
    listConversationsPage: jest.fn(),
    listConversationsKeysetPage: jest.fn(),
    getConversation: jest.fn(),
  };
  const logger: LoggerService = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };
  const asViewer = {
    canActivate: (context: ExecutionContext) => {
      const req = context
        .switchToHttp()
        .getRequest<{ user?: { userId: string } }>();
      req.user = { userId: 'viewer-1' };
      return true;
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    chatService.listConversationsPage.mockResolvedValue({
      conversations: [{ id: 'legacy-1' }],
      hasMore: true,
    });
    chatService.listConversationsKeysetPage.mockResolvedValue({
      conversations: [{ id: LAST_ID }],
      hasMore: true,
      nextCursor: LAST_ID,
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: GroupAdmissionService, useValue: {} },
        { provide: ChatGroupAdminService, useValue: {} },
        { provide: ChatGroupEventService, useValue: {} },
        { provide: ChatGroupSettingsService, useValue: {} },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(asViewer)
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

  it('keeps the legacy activity-ordered list when no cursor is sent', async () => {
    const response = await request(app.getHttpServer())
      .get(ROUTE)
      .query({ limit: '2' })
      .expect(200);

    expect(response.body).toEqual([{ id: 'legacy-1' }]);
    expect(chatService.listConversationsPage).toHaveBeenCalledWith(
      'viewer-1',
      2,
    );
    expect(chatService.listConversationsKeysetPage).not.toHaveBeenCalled();
    expect(response.headers['x-has-more']).toBe('true');
    expect(response.headers['x-next-cursor']).toBeUndefined();
  });

  // 查询串里的 `?cursor=` 解析成空串 —— 它是「从头开始」，不是「没带」。
  it('treats an empty cursor as the first keyset page', async () => {
    const response = await request(app.getHttpServer())
      .get(`${ROUTE}?cursor=&limit=1`)
      .expect(200);

    expect(response.body).toEqual([{ id: LAST_ID }]);
    expect(chatService.listConversationsKeysetPage).toHaveBeenCalledWith(
      'viewer-1',
      '',
      1,
    );
    expect(chatService.listConversationsPage).not.toHaveBeenCalled();
    expect(response.headers['x-has-more']).toBe('true');
    expect(response.headers['x-next-cursor']).toBe(LAST_ID);
  });

  it('continues after a conversation id cursor and drops X-Next-Cursor on the last page', async () => {
    chatService.listConversationsKeysetPage.mockResolvedValueOnce({
      conversations: [],
      hasMore: false,
      nextCursor: null,
    });

    const response = await request(app.getHttpServer())
      .get(ROUTE)
      .query({ cursor: LAST_ID.toUpperCase() })
      .expect(200);

    expect(response.body).toEqual([]);
    // 大写 id 归一成库里的小写形态再比较。
    expect(chatService.listConversationsKeysetPage).toHaveBeenCalledWith(
      'viewer-1',
      LAST_ID,
      undefined,
    );
    expect(response.headers['x-has-more']).toBe('false');
    expect(response.headers['x-next-cursor']).toBeUndefined();
  });

  it.each([
    ['a slug', 'cursor=conv-1'],
    ['an id with trailing garbage', `cursor=${LAST_ID}x`],
    ['a repeated cursor parameter', `cursor=${LAST_ID}&cursor=${LAST_ID}`],
    ['a SQL fragment', `cursor=${encodeURIComponent("' OR 1=1 --")}`],
  ])('rejects %s with the standard 400 envelope', async (_case, query) => {
    const response = await request(app.getHttpServer())
      .get(`${ROUTE}?${query}`)
      .expect(400);

    expect(chatService.listConversationsKeysetPage).not.toHaveBeenCalled();
    expect(chatService.listConversationsPage).not.toHaveBeenCalled();
    expect(response.body).toEqual({
      code: 400,
      message: expect.stringContaining('cursor'),
      data: null,
    });
  });

  describe('GET /chat/conversations/:id', () => {
    // 会话元信息变更事件只刷新这一个会话,不再重拉整张列表。
    const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

    it('returns the single conversation row for the viewer', async () => {
      chatService.getConversation.mockResolvedValueOnce({ id: CONVERSATION_ID });

      const response = await request(app.getHttpServer())
        .get(`${ROUTE}/${CONVERSATION_ID}`)
        .expect(200);

      expect(response.body).toEqual({ id: CONVERSATION_ID });
      expect(chatService.getConversation).toHaveBeenCalledWith(
        'viewer-1',
        CONVERSATION_ID,
      );
      expect(chatService.listConversationsPage).not.toHaveBeenCalled();
    });

    it('rejects a malformed id before reaching the service', async () => {
      await request(app.getHttpServer())
        .get(`${ROUTE}/not-a-conversation`)
        .expect(400);
      expect(chatService.getConversation).not.toHaveBeenCalled();
    });

    it('surfaces "not a member" with its stable error code', async () => {
      chatService.getConversation.mockRejectedValueOnce(
        new ForbiddenException({
          message: '不是会话成员',
          errorCode: ChatErrorCode.NotMember,
        }),
      );

      const response = await request(app.getHttpServer())
        .get(`${ROUTE}/${CONVERSATION_ID}`)
        .expect(403);

      expect(response.body.errorCode).toBe(ChatErrorCode.NotMember);
    });
  });
});
