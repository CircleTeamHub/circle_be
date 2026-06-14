import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CallWebhookController } from './call.webhook.controller';

describe('CallWebhookController', () => {
  it('verifies LiveKit webhook raw body and forwards the event', async () => {
    const livekit = {
      verifyWebhook: jest.fn().mockResolvedValue({
        event: 'room_finished',
        room: { name: 'circle_call_1' },
      }),
    };
    const calls = { handleLiveKitWebhook: jest.fn().mockResolvedValue(undefined) };
    const controller = new CallWebhookController(livekit as any, calls as any);
    const req = { rawBody: Buffer.from('{"event":"room_finished"}') };

    await controller.handleLiveKitWebhook('Bearer token', req as any);

    expect(livekit.verifyWebhook).toHaveBeenCalledWith(
      '{"event":"room_finished"}',
      'Bearer token',
    );
    expect(calls.handleLiveKitWebhook).toHaveBeenCalledWith({
      event: 'room_finished',
      room: { name: 'circle_call_1' },
    });
  });

  it('rejects requests without raw body', async () => {
    const controller = new CallWebhookController({} as any, {} as any);

    await expect(
      controller.handleLiveKitWebhook('Bearer token', {} as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('normalizes signature failures to UnauthorizedException', async () => {
    const livekit = {
      verifyWebhook: jest.fn().mockRejectedValue(new Error('bad signature')),
    };
    const calls = { handleLiveKitWebhook: jest.fn() };
    const controller = new CallWebhookController(livekit as any, calls as any);

    await expect(
      controller.handleLiveKitWebhook('Bearer token', {
        rawBody: Buffer.from('{}'),
      } as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(calls.handleLiveKitWebhook).not.toHaveBeenCalled();
  });
});
