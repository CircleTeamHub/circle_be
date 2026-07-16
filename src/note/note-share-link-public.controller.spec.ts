import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { NoteShareLinkPublicController } from './note-share-link-public.controller';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

describe('NoteShareLinkPublicController', () => {
  let app: INestApplication;
  const noteService = { resolveShareLink: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [NoteShareLinkPublicController],
      providers: [{ provide: NoteService, useValue: noteService }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // 这条是整个设计的关键前提：分享链接从二维码打开，扫码者没有 Circle 会话。
  // 若有人日后给这个 controller 挂上 JwtGuard，分享功能会静默失效 —— 用元数据
  // 断言把「公开」这件事钉死。
  it('is not JWT-guarded, unlike the class-level-guarded NoteController', () => {
    const publicGuards =
      Reflect.getMetadata('__guards__', NoteShareLinkPublicController) ?? [];
    const noteGuards = Reflect.getMetadata('__guards__', NoteController) ?? [];

    expect(publicGuards).not.toContain(JwtGuard);
    // NoteController 是类级 JwtGuard —— 正是不能把本路由加进去的原因。
    expect(noteGuards).toContain(JwtGuard);
  });

  it('serves GET /note/share-links/:token without an Authorization header', async () => {
    noteService.resolveShareLink.mockResolvedValueOnce({
      title: '我的笔记',
      notes: [],
      expiresAt: null,
    });

    const response = await request(app.getHttpServer())
      .get('/note/share-links/tok-abc')
      .expect(200);

    expect(noteService.resolveShareLink).toHaveBeenCalledWith('tok-abc');
    expect(response.body).toMatchObject({ title: '我的笔记', notes: [] });
  });

  it('surfaces an invalid/expired/revoked token as 404', async () => {
    noteService.resolveShareLink.mockRejectedValueOnce(
      new NotFoundException({
        message: 'Share link not found',
        errorCode: 'NOTE_SHARE_LINK_INVALID',
      }),
    );

    await request(app.getHttpServer())
      .get('/note/share-links/tok-nope')
      .expect(404);
  });

  it('does not shadow the authenticated GET /note/:id route', async () => {
    // /note/share-links/xxx 是两段路径，吃不到 NoteController 的 @Get(':id')；
    // 反过来单段的 /note/xxx 也不会落进这个公开 controller。
    await request(app.getHttpServer())
      .get('/note/2f1c8b1e-0000-4000-8000-000000000000')
      .expect(404);
    expect(noteService.resolveShareLink).not.toHaveBeenCalled();
  });
});
