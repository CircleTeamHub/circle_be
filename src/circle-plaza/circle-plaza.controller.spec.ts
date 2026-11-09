import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { IdempotencyScope } from 'src/idempotency/idempotency.service';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaService } from './circle-plaza.service';

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

  it('exposes POST /seen to clear the plaza update dot', async () => {
    const service = { markPlazaSeen: jest.fn().mockResolvedValue(undefined) };
    const controller = new CirclePlazaController(service as any, {} as any);

    await controller.seen({ user: { userId: 'viewer-1' } } as any);

    const handler = CirclePlazaController.prototype.seen;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('seen');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(60);
    expect(service.markPlazaSeen).toHaveBeenCalledWith('viewer-1');
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
