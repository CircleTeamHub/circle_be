import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';
import { JwtGuard } from '../guards/jwt.guard';
import { createNoteWriteLimiterMount } from '../setup';

it('isolates per-account autosaves from the ordinary note-write budget', async () => {
  const module = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    ],
    controllers: [NoteController],
    providers: [
      {
        provide: NoteService,
        useValue: {
          saveNoteDraft: jest.fn().mockResolvedValue({}),
          createNote: jest.fn().mockResolvedValue({}),
        },
      },
    ],
  })
    .overrideGuard(JwtGuard)
    .useValue({
      canActivate: (context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = { userId: req.headers['x-test-user'] ?? 'user-a' };
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(
    '/api/v1/note',
    createNoteWriteLimiterMount(rateLimit({ windowMs: 15 * 60_000, max: 60 })),
  );
  await app.init();
  try {
    const server = app.getHttpServer();
    for (let i = 0; i < 120; i++)
      await request(server).put('/api/v1/note/drafts/one').send({}).expect(200);
    await request(server).put('/api/v1/note/drafts/one').send({}).expect(429);
    await request(server)
      .put('/api/v1/note/drafts/one')
      .set('x-test-user', 'user-b')
      .send({})
      .expect(200);
    for (let i = 0; i < 60; i++)
      await request(server).post('/api/v1/note').send({}).expect(201);
    await request(server).post('/api/v1/note').send({}).expect(429);
    await request(server)
      .put('/api/v1/note/drafts/one')
      .set('x-test-user', 'user-b')
      .send({})
      .expect(200);
  } finally {
    await app.close();
  }
}, 20_000);
