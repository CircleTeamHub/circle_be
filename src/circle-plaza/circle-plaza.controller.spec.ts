import { HttpStatus, RequestMethod, ValidationPipe } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { IdempotencyScope } from 'src/idempotency/idempotency.service';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaService } from './circle-plaza.service';
import { PlazaSeenDto } from './dto/circle-plaza.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('CirclePlazaController', () => {
  it('requires authentication and throttling for plaza routes', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CirclePlazaController);

    expect(guards).toEqual([ThrottlerGuard, JwtGuard]);
  });

  it('throttles write-heavy plaza actions', () => {
    const create = CirclePlazaController.prototype.create;
    const signup = CirclePlazaController.prototype.signup;
    const cancelSignup = CirclePlazaController.prototype.cancelSignup;
    const readMyPostSignups = CirclePlazaController.prototype.readMyPostSignups;

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', create)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', create)).toBe(60_000);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', signup)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', cancelSignup)).toBe(
      30,
    );
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', readMyPostSignups),
    ).toBe(60);
  });

  // GET /circle-plaza/posts/:id/signups 没有任何客户端调用 —— App 的报名管理走
  // GET /me/posts/:id/signups(带未读/认可状态)。旧路由连同 service 方法一起删掉。
  it('no longer exposes the legacy GET /posts/:id/signups list', () => {
    expect(
      (CirclePlazaController.prototype as unknown as Record<string, unknown>)
        .signups,
    ).toBeUndefined();
    expect(
      (CirclePlazaService.prototype as unknown as Record<string, unknown>)
        .getPostSignups,
    ).toBeUndefined();
  });

  it('keeps the legacy empty body valid and the 204 route available', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const metatype = Reflect.getMetadata(
      'design:paramtypes',
      CirclePlazaController.prototype,
      'seen',
    )[0];
    await expect(
      pipe.transform({}, { type: 'body', metatype }),
    ).resolves.toEqual({});
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        CirclePlazaController.prototype.seen,
      ),
    ).toBe(HttpStatus.NO_CONTENT);
    const service = {
      markPlazaSeen: jest.fn().mockResolvedValue({ hasUpdate: false }),
    };
    const controller = new CirclePlazaController(service as any, {} as any);
    await expect(
      controller.seen({ user: { userId: 'viewer-1' } } as any),
    ).resolves.toBeUndefined();
    expect(service.markPlazaSeen).toHaveBeenCalledWith('viewer-1');
  });

  it('validates the versioned route through ValidationPipe', async () => {
    const handler = CirclePlazaController.prototype.seenThrough;
    expect(handler).toBeDefined();
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('seen-through');
    const metatype = Reflect.getMetadata(
      'design:paramtypes',
      CirclePlazaController.prototype,
      'seenThrough',
    )[0];
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const valid = { snapshotAt: '2026-11-09T00:00:00.123Z' };
    await expect(
      pipe.transform(valid, { type: 'body', metatype }),
    ).resolves.toEqual(valid);
    for (const body of [
      {},
      { snapshotAt: null },
      { snapshotAt: 'invalid' },
      { snapshotAt: '2026-02-30T00:00:00Z' },
    ]) {
      await expect(
        pipe.transform(body, { type: 'body', metatype }),
      ).rejects.toThrow();
    }
  });

  it('accepts a feed snapshot on POST /seen-through and returns remaining updates', async () => {
    const service = {
      markPlazaSeen: jest.fn().mockResolvedValue({
        hasUpdate: true,
        changedAt: '2026-11-09T00:00:10.000Z',
      }),
    };
    const controller = new CirclePlazaController(service as any, {} as any);

    const body = { snapshotAt: '2026-11-09T00:00:00.123Z' };
    await expect(
      controller.seenThrough(body, { user: { userId: 'viewer-1' } } as any),
    ).resolves.toEqual({
      hasUpdate: true,
      changedAt: '2026-11-09T00:00:10.000Z',
    });

    const handler = CirclePlazaController.prototype.seenThrough;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('seen-through');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(60);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
    expect(service.markPlazaSeen).toHaveBeenCalledWith(
      'viewer-1',
      body.snapshotAt,
    );
  });

  it.each([
    {},
    { snapshotAt: null },
    { snapshotAt: 'invalid' },
    { snapshotAt: '2026-02-30T00:00:00.000Z' },
    { snapshotAt: 123 },
  ])('rejects invalid seen watermarks: %j', async (body) => {
    const errors = await validate(
      plainToInstance(PlazaSeenDto, body) as object,
    );
    expect(errors.some((error) => error.property === 'snapshotAt')).toBe(true);
  });

  it('accepts an ISO feed snapshot watermark', async () => {
    await expect(
      validate(
        plainToInstance(PlazaSeenDto, {
          snapshotAt: '2026-11-09T00:00:00.123Z',
        }) as object,
      ),
    ).resolves.toEqual([]);
  });

  it('exposes authenticated POST /feed/search and delegates to the feed query', async () => {
    const service = { getFeed: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new CirclePlazaController(service as any, {} as any);
    const body = { cities: [' Shanghai ', 'Shanghai'], limit: 25 };

    await controller.feedSearch(body, {
      user: { userId: 'viewer-1' },
    } as any);

    const handler = CirclePlazaController.prototype.feedSearch;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('feed/search');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(service.getFeed).toHaveBeenCalledWith('viewer-1', body);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(60);
  });

  it('runs post creation under its own idempotency scope with the raw header', async () => {
    const post = { id: 'post-1' };
    const service = { createPost: jest.fn().mockResolvedValue(post) };
    const idempotency = {
      run: jest.fn((_request: unknown, operation: () => Promise<unknown>) =>
        operation(),
      ),
    };
    const controller = new CirclePlazaController(
      service as any,
      idempotency as any,
    );
    const dto = { circleId: 'circle-1', title: 'Looking for a drummer' };

    await expect(
      controller.create(
        dto as any,
        { user: { userId: 'author-1' } } as any,
        'plaza-retry-01',
      ),
    ).resolves.toBe(post);

    expect(idempotency.run).toHaveBeenCalledWith(
      {
        scope: IdempotencyScope.PlazaPostCreate,
        userId: 'author-1',
        key: 'plaza-retry-01',
        request: dto,
      },
      expect.any(Function),
    );
    expect(service.createPost).toHaveBeenCalledWith('author-1', dto);
    expect(
      Reflect.getMetadata(
        'swagger/apiParameters',
        CirclePlazaController.prototype.create,
      ),
    ).toContainEqual(
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
      }),
    );
  });
});
