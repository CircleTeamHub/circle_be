import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CirclePlazaController } from './circle-plaza.controller';

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

  it('passes the current user when reading the legacy signup list', async () => {
    const service = {
      getPostSignups: jest.fn().mockResolvedValue({ items: [] }),
    };
    const controller = new CirclePlazaController(service as any);

    await controller.signups('post-1', {
      user: { userId: 'author-1' },
    } as any);

    expect(service.getPostSignups).toHaveBeenCalledWith('author-1', 'post-1');
  });
});
