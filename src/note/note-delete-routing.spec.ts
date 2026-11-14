import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { IdempotencyService } from 'src/idempotency/idempotency.service';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

/**
 * 2026-11 取消回收站：DELETE /note/:id 就是永久删除，恢复 / 立即删除 / 回收站列表三条
 * 路由都没了。真正起一个 Nest app 发请求，验路由表本身。
 */
describe('note delete routes without the recycle bin', () => {
  let app: INestApplication;
  let baseUrl: string;
  const id = '22222222-2222-4222-8222-222222222222';
  const noteService = {
    deleteNote: jest.fn().mockResolvedValue(undefined),
    getNote: jest.fn().mockResolvedValue({}),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ limit: 1000, ttl: 60_000 }])],
      controllers: [NoteController],
      providers: [
        { provide: IdempotencyService, useValue: {} },
        { provide: NoteService, useValue: noteService },
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
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
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('DELETE /note/:id deletes permanently through deleteNote', async () => {
    const res = await fetch(`${baseUrl}/note/${id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(noteService.deleteNote).toHaveBeenCalledWith('user-1', id);
  });

  it.each([
    ['POST', `/note/${id}/restore`],
    ['DELETE', `/note/${id}/permanent`],
  ])('%s %s is gone (404)', async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, { method });

    expect(res.status).toBe(404);
    expect(noteService.deleteNote).not.toHaveBeenCalled();
  });

  it('GET /note/recycle-bin no longer lists anything: it falls through to the :id route', async () => {
    const res = await fetch(`${baseUrl}/note/recycle-bin`);

    // 'recycle-bin' 不是 UUID：被 GET /note/:id 的 ParseUUIDPipe 拒成 400，不会到 service。
    expect(res.status).toBe(400);
    expect(noteService.getNote).not.toHaveBeenCalled();
  });
});
