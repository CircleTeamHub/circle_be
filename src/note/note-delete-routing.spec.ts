import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { IdempotencyService } from 'src/idempotency/idempotency.service';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

/**
 * 回收站（2026-11-13 取消后又恢复）：DELETE /note/:id 软删进回收站，恢复 / 立即删除 /
 * 回收站列表三条路由各自走到自己的 service 方法。真正起一个 Nest app 发请求，验路由表
 * 本身 —— 尤其 GET /note/recycle-bin 不能被 GET /note/:id 的 ParseUUIDPipe 先截走、
 * DELETE /note/:id/permanent 不能落到 DELETE /note/:id。
 */
describe('note delete and recycle-bin routes', () => {
  let app: INestApplication;
  let baseUrl: string;
  const id = '22222222-2222-4222-8222-222222222222';
  const noteService = {
    deleteNote: jest.fn().mockResolvedValue(undefined),
    getNote: jest.fn().mockResolvedValue({}),
    listDeletedNotes: jest
      .fn()
      .mockResolvedValue({ items: [{ id }], hasMore: false }),
    restoreNote: jest.fn().mockResolvedValue(undefined),
    purgeNote: jest.fn().mockResolvedValue(undefined),
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

  it('DELETE /note/:id soft deletes through deleteNote', async () => {
    const res = await fetch(`${baseUrl}/note/${id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(noteService.deleteNote).toHaveBeenCalledWith('user-1', id);
    expect(noteService.purgeNote).not.toHaveBeenCalled();
  });

  it('GET /note/recycle-bin lists my deleted notes as an array with X-Has-More', async () => {
    const res = await fetch(`${baseUrl}/note/recycle-bin?page=2&limit=20`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id }]);
    expect(res.headers.get('x-has-more')).toBe('false');
    expect(noteService.listDeletedNotes).toHaveBeenCalledWith('user-1', 2, 20);
    expect(noteService.getNote).not.toHaveBeenCalled();
  });

  it('POST /note/:id/restore restores through restoreNote', async () => {
    const res = await fetch(`${baseUrl}/note/${id}/restore`, {
      method: 'POST',
    });

    expect(res.status).toBe(201);
    expect(noteService.restoreNote).toHaveBeenCalledWith('user-1', id);
  });

  it('DELETE /note/:id/permanent purges through purgeNote, not the soft delete', async () => {
    const res = await fetch(`${baseUrl}/note/${id}/permanent`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(noteService.purgeNote).toHaveBeenCalledWith('user-1', id);
    expect(noteService.deleteNote).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/note/not-a-uuid/restore'],
    ['DELETE', '/note/not-a-uuid/permanent'],
  ])(
    '%s %s rejects a non-UUID id before reaching the service',
    async (method, path) => {
      const res = await fetch(`${baseUrl}${path}`, { method });

      expect(res.status).toBe(400);
      expect(noteService.restoreNote).not.toHaveBeenCalled();
      expect(noteService.purgeNote).not.toHaveBeenCalled();
    },
  );
});
