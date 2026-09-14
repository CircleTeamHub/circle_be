import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
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

  it('exposes authenticated POST /feed/search and delegates to the feed query', async () => {
    const service = { getFeed: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new CirclePlazaController(service as any);
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
});
