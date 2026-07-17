import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

/**
 * 分享链接管理路由的 HTTP 契约测试（真正起一个 Nest app 发请求）。
 *
 * note.controller.spec.ts 是直接 `new NoteController()` 调方法的单元测试，
 * **绕过了路由和 pipe**，因此测不到这里的两件事：
 *
 * 1. `@Get('share-links')` 必须声明在 `@Get(':id')` 之前。Nest 按声明顺序匹配，
 *    顺序写反时 /note/share-links 会先命中 `@Get(':id')`，被那条路由的
 *    ParseUUIDPipe 当成非法 UUID 打成 **400** —— 静默失败，看起来像客户端传错，
 *    实际是服务端路由写错。（此断言已验证：把两个方法调换顺序，本用例会红。）
 * 2. 吊销返回 204 而不是 200（`@HttpCode`），以及 `:id` 的 UUID 校验。
 */
describe('note share-link management routing', () => {
  let app: INestApplication;
  let baseUrl: string;

  const noteService = {
    listShareLinks: jest.fn(),
    revokeShareLink: jest.fn(),
    getNote: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // NoteController 上另有挂 ThrottlerGuard 的路由，缺这个模块整个 app 起不来。
      imports: [ThrottlerModule.forRoot([{ limit: 1000, ttl: 60_000 }])],
      controllers: [NoteController],
      providers: [{ provide: NoteService, useValue: noteService }],
    })
      // 只验路由，不验鉴权：放行并注入一个固定用户。
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
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    noteService.listShareLinks.mockResolvedValue([]);
    noteService.revokeShareLink.mockResolvedValue(undefined);
    noteService.getNote.mockResolvedValue({});
  });

  it('routes GET /note/share-links to listShareLinks instead of the :id route', async () => {
    const res = await fetch(`${baseUrl}/note/share-links`);

    expect(res.status).toBe(200);
    expect(noteService.listShareLinks).toHaveBeenCalledWith('user-1', {});
    // 顺序写反的典型症状：'share-links' 被当成 :id 传进 getNote。
    expect(noteService.getNote).not.toHaveBeenCalled();
  });

  it('passes share link paging params through from the query string', async () => {
    const res = await fetch(`${baseUrl}/note/share-links?page=2&limit=20`);

    expect(res.status).toBe(200);
    // 本测试的 app 没挂全局 ValidationPipe（enableImplicitConversion），所以这里
    // 拿到的是字符串；真实进程里 setup.ts 的 pipe 会按 DTO 上的类型转成 number。
    expect(noteService.listShareLinks).toHaveBeenCalledWith('user-1', {
      page: '2',
      limit: '20',
    });
  });

  it('routes DELETE /note/share-links/:id to revokeShareLink and answers 204', async () => {
    const id = '22222222-2222-2222-2222-222222222222';

    const res = await fetch(`${baseUrl}/note/share-links/${id}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(noteService.revokeShareLink).toHaveBeenCalledWith('user-1', id);
  });

  it('rejects a non-uuid share link id before reaching the service', async () => {
    const res = await fetch(`${baseUrl}/note/share-links/not-a-uuid`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(400);
    expect(noteService.revokeShareLink).not.toHaveBeenCalled();
  });
});
