import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { StickerController } from './sticker.controller';

describe('StickerController', () => {
  it('guards every collection and media endpoint with JWT and throttling', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StickerController)).toEqual([
      JwtGuard,
      ThrottlerGuard,
    ]);
  });
  it('takes ownership only from the authenticated request', () => {
    const service = {
      list: jest.fn(),
      create: jest.fn(),
      remove: jest.fn(),
      prepareMessage: jest.fn(),
    };
    const controller = new StickerController(service as never);
    const request = { user: { userId: 'alice' } } as never;
    controller.list(request);
    controller.create(request, { messageId: 'm1' });
    controller.remove(request, 's1');
    controller.prepareMessage(request, 's1');
    expect(service.list).toHaveBeenCalledWith('alice');
    expect(service.create).toHaveBeenCalledWith('alice', { messageId: 'm1' });
    expect(service.remove).toHaveBeenCalledWith('alice', 's1');
    expect(service.prepareMessage).toHaveBeenCalledWith('alice', 's1');
  });
});
