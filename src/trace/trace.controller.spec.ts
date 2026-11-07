import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { RequestWithUser } from 'src/auth/types';
import { IdempotencyScope } from 'src/idempotency/idempotency.service';
import { SetTraceLikeDto } from './dto/trace.dto';
import { TraceController } from './trace.controller';

describe('TraceController', () => {
  const req = { user: { userId: 'viewer-1' } } as RequestWithUser;

  function build() {
    const traceService = {
      createTrace: jest.fn().mockResolvedValue({ id: 'trace-1' }),
      addComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
      toggleLike: jest.fn().mockResolvedValue({ liked: true, likeCount: 1 }),
      setLike: jest.fn().mockResolvedValue({ liked: true, likeCount: 1 }),
    };
    const idempotency = {
      run: jest.fn((_request: unknown, operation: () => Promise<unknown>) =>
        operation(),
      ),
    };
    const controller = new TraceController(
      traceService as never,
      idempotency as never,
    );
    return { controller, traceService, idempotency };
  }

  const documentsIdempotencyKey = (handler: unknown) =>
    expect(
      Reflect.getMetadata('swagger/apiParameters', handler as object),
    ).toContainEqual(
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
      }),
    );

  it('posts a moment under its own idempotency scope with the raw header', async () => {
    const { controller, traceService, idempotency } = build();
    const dto = { content: 'hello' } as never;

    await expect(
      controller.create(dto, req, 'moment-retry-01'),
    ).resolves.toEqual({ id: 'trace-1' });

    expect(idempotency.run).toHaveBeenCalledWith(
      {
        scope: IdempotencyScope.MomentCreate,
        userId: 'viewer-1',
        key: 'moment-retry-01',
        request: dto,
      },
      expect.any(Function),
    );
    expect(traceService.createTrace).toHaveBeenCalledWith('viewer-1', dto);
    documentsIdempotencyKey(TraceController.prototype.create);
  });

  // 同一份评论内容发到两条动态上不是重放：指纹要带上路由里的动态 id。
  it('comments under its own scope, fingerprinting the moment id with the body', async () => {
    const { controller, traceService, idempotency } = build();
    const dto = { content: 'nice' } as never;

    await expect(
      controller.comment('trace-1', dto, req, 'comment-retry-01'),
    ).resolves.toEqual({ id: 'comment-1' });

    expect(idempotency.run).toHaveBeenCalledWith(
      {
        scope: IdempotencyScope.MomentCommentCreate,
        userId: 'viewer-1',
        key: 'comment-retry-01',
        request: { traceId: 'trace-1', body: dto },
      },
      expect.any(Function),
    );
    expect(traceService.addComment).toHaveBeenCalledWith(
      'viewer-1',
      'trace-1',
      dto,
    );
    documentsIdempotencyKey(TraceController.prototype.comment);
  });

  it('exposes PUT /trace/:id/like that sets the requested state', async () => {
    const { controller, traceService } = build();

    await expect(
      controller.setLike('trace-1', { liked: false }, req),
    ).resolves.toEqual({ liked: true, likeCount: 1 });

    const handler = TraceController.prototype.setLike;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/like');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.PUT,
    );
    expect(traceService.setLike).toHaveBeenCalledWith(
      'viewer-1',
      'trace-1',
      false,
    );
    expect(traceService.toggleLike).not.toHaveBeenCalled();
  });

  it('keeps POST /trace/:id/like as the toggle for installed apps', async () => {
    const { controller, traceService } = build();

    await controller.like('trace-1', req);

    const handler = TraceController.prototype.like;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/like');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(traceService.toggleLike).toHaveBeenCalledWith('viewer-1', 'trace-1');
  });

  describe('SetTraceLikeDto', () => {
    // 与全局 ValidationPipe 同款选项（src/setup.ts）。
    const validate = (body: Record<string, unknown>) =>
      validateSync(plainToInstance(SetTraceLikeDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it.each([[true], [false]])('accepts liked: %s', (liked) => {
      expect(validate({ liked })).toEqual([]);
    });

    it.each([
      ['a missing flag', {}],
      ['a string flag', { liked: 'true' }],
      ['a numeric flag', { liked: 1 }],
      ['an extra field', { liked: true, likeCount: 99 }],
    ])('rejects %s', (_case, body) => {
      expect(validate(body)).not.toEqual([]);
    });
  });
});
