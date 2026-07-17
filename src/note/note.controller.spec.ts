import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

describe('NoteController', () => {
  const noteService = {
    listNotes: jest.fn(),
    createNoteExport: jest.fn(),
    revokeShareLink: jest.fn(),
    deleteNote: jest.fn(),
  };
  const req = {
    user: { userId: 'user-1' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns summary section flags from GET /note through the service contract', async () => {
    const rows = [
      {
        id: 'note-1',
        ownerId: 'user-1',
        canEdit: true,
        title: 'Trip',
        contentPreview: 'hello',
        status: 'ACTIVE',
        available: true,
        pinned: false,
        groups: [{ id: 'group-1', name: 'Diary' }],
        cover: null,
        imageCount: 1,
        videoCount: 1,
        mediaCount: 2,
        hasText: true,
        showcaseCount: 3,
        hasLocation: true,
        createdAt: new Date('2026-06-29T12:00:00.000Z'),
        updatedAt: new Date('2026-06-29T12:00:00.000Z'),
      },
    ];
    noteService.listNotes.mockResolvedValueOnce(rows);
    const controller = new NoteController(noteService as any);

    const result = await controller.listNotes({ status: 'ACTIVE' } as any, req);

    expect(noteService.listNotes).toHaveBeenCalledWith('user-1', {
      status: 'ACTIVE',
    });
    expect(result[0]).toMatchObject({
      hasText: true,
      showcaseCount: 3,
      hasLocation: true,
      imageCount: 1,
      videoCount: 1,
    });
  });

  it('posts note export requests with viewer, note id, format, and scope', async () => {
    const exportResult = {
      url: 'https://signed.example.com/note.pdf',
      filename: 'Trip.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      expiresAt: new Date('2026-06-29T12:15:00.000Z'),
    };
    noteService.createNoteExport.mockResolvedValueOnce(exportResult);
    const controller = new NoteController(noteService as any);

    const result = await controller.createNoteExport(
      '11111111-1111-1111-1111-111111111111',
      { format: 'PDF', scope: 'ALL' } as any,
      req,
    );

    expect(noteService.createNoteExport).toHaveBeenCalledWith(
      'user-1',
      '11111111-1111-1111-1111-111111111111',
      { format: 'PDF', scope: 'ALL' },
    );
    expect(result).toEqual(exportResult);
  });

  // ── DELETE /note/share-links/:id（吊销，docs 第 2 节）─────────────────────
  describe('revokeShareLink', () => {
    const linkId = '11111111-1111-4111-8111-111111111111';

    // 吊销人只能来自 JWT。若哪天有人把 ownerId 挪进 body/query 让调用方自己传，
    // 这个接口立刻退化成 IDOR —— 用「service 收到的是 req.user.userId」钉死。
    it('derives the revoking owner from the JWT, never from client input', async () => {
      noteService.revokeShareLink.mockResolvedValueOnce({
        id: linkId,
        revokedAt: new Date('2026-06-09T00:00:00.000Z'),
      });
      const controller = new NoteController(noteService as any);

      await controller.revokeShareLink(linkId, req);

      expect(noteService.revokeShareLink).toHaveBeenCalledWith(
        'user-1',
        linkId,
      );
    });

    // NoteController 上已经有一条 `@Delete(':id')`（软删除笔记）。它只吃单段
    // 路径，而本路由是两段，因此不冲突 —— 但这是路由顺序的隐性依赖，用一条
    // 真实 HTTP 断言钉死：吊销请求必须打到 revokeShareLink，绝不能误删笔记。
    describe('routing', () => {
      let app: INestApplication;

      beforeEach(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({
          imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
          controllers: [NoteController],
          providers: [{ provide: NoteService, useValue: noteService }],
        })
          .overrideGuard(JwtGuard)
          .useValue({
            canActivate: (context: any) => {
              context.switchToHttp().getRequest().user = { userId: 'user-1' };
              return true;
            },
          })
          .compile();

        app = moduleRef.createNestApplication();
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      it('routes DELETE /note/share-links/:id to revokeShareLink, not deleteNote', async () => {
        noteService.revokeShareLink.mockResolvedValueOnce({
          id: linkId,
          revokedAt: new Date('2026-06-09T00:00:00.000Z'),
        });

        await request(app.getHttpServer())
          .delete(`/note/share-links/${linkId}`)
          .expect(200);

        expect(noteService.revokeShareLink).toHaveBeenCalledWith(
          'user-1',
          linkId,
        );
        // 最坏的失败模式：请求落到 `@Delete(':id')` 上，把笔记删了。
        expect(noteService.deleteNote).not.toHaveBeenCalled();
      });
    });
  });
});
