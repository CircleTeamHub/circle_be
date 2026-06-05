import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ChatHistoryController } from './chat-history.controller';
import { ChatHistoryService } from './chat-history.service';

describe('ChatHistoryController HTTP pipeline', () => {
  let app: INestApplication;
  const service = {
    getMessages: jest.fn().mockResolvedValue({
      conversationID: 'si_a_b',
      messages: [],
      hasMore: false,
      nextBeforeSeq: null,
      serverMinSeq: null,
      serverMaxSeq: null,
    }),
  };

  beforeEach(async () => {
    service.getMessages.mockClear();

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [ChatHistoryController],
      providers: [{ provide: ChatHistoryService, useValue: service }],
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
    app.setGlobalPrefix('api/v1');
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

  it('passes authenticated user and transformed query values to the service', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/chat-history/conversations/si_a_b/messages')
      .query({ limit: '50', beforeSeq: '10' })
      .expect(200);

    expect(service.getMessages).toHaveBeenCalledWith(
      'user-1',
      'si_a_b',
      50,
      10,
    );
  });

  it('rejects invalid query values before the service is called', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/chat-history/conversations/si_a_b/messages')
      .query({ limit: '500' })
      .expect(400);

    expect(service.getMessages).not.toHaveBeenCalled();
  });
});
