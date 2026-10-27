import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { callMetrics } from 'src/metrics/call-metrics';
import { CallWebhookController } from './call.webhook.controller';

describe('CallWebhookController', () => {
  const rawBody = '{"event":"room_finished"}';
  const roomFinished = {
    event: 'room_finished',
    room: { name: 'circle_call_1' },
  };
  let recordWebhook: jest.SpyInstance;

  beforeEach(() => {
    recordWebhook = jest.spyOn(callMetrics, 'recordLiveKitWebhook');
  });

  afterEach(() => jest.restoreAllMocks());

  function controllerWith(
    handle: jest.Mock,
    verify: jest.Mock = jest.fn().mockResolvedValue(roomFinished),
  ) {
    const livekit = { verifyWebhook: verify };
    const calls = { handleLiveKitWebhook: handle };
    return {
      controller: new CallWebhookController(livekit as any, calls as any),
      livekit,
      calls,
    };
  }

  const request = () => ({ rawBody: Buffer.from(rawBody) }) as any;

  it('verifies LiveKit webhook raw body and forwards the event', async () => {
    const { controller, livekit, calls } = controllerWith(
      jest.fn().mockResolvedValue('handled'),
    );

    await expect(
      controller.handleLiveKitWebhook('Bearer token', request()),
    ).resolves.toEqual({ ok: true });

    expect(livekit.verifyWebhook).toHaveBeenCalledWith(rawBody, 'Bearer token');
    expect(calls.handleLiveKitWebhook).toHaveBeenCalledWith(roomFinished);
    expect(recordWebhook).toHaveBeenCalledTimes(1);
    expect(recordWebhook).toHaveBeenCalledWith('handled');
  });

  it('counts verified events the service did not act on as ignored', async () => {
    const { controller } = controllerWith(
      jest.fn().mockResolvedValue('ignored'),
    );

    await controller.handleLiveKitWebhook('Bearer token', request());

    expect(recordWebhook).toHaveBeenCalledTimes(1);
    expect(recordWebhook).toHaveBeenCalledWith('ignored');
  });

  it('rejects requests without raw body', async () => {
    const controller = new CallWebhookController({} as any, {} as any);

    await expect(
      controller.handleLiveKitWebhook('Bearer token', {} as any),
    ).rejects.toThrow(BadRequestException);
    expect(recordWebhook).toHaveBeenCalledWith('rejected');
  });

  it('normalizes signature failures to UnauthorizedException', async () => {
    const { controller, calls } = controllerWith(
      jest.fn(),
      jest.fn().mockRejectedValue(new Error('bad signature')),
    );

    await expect(
      controller.handleLiveKitWebhook('Bearer token', {
        rawBody: Buffer.from('{}'),
      } as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(calls.handleLiveKitWebhook).not.toHaveBeenCalled();
    expect(recordWebhook).toHaveBeenCalledTimes(1);
    expect(recordWebhook).toHaveBeenCalledWith('rejected');
  });

  it('keeps "LiveKit not configured" on the 401 path, as before', async () => {
    const { controller } = controllerWith(
      jest.fn(),
      jest.fn().mockRejectedValue(new Error('LiveKit is not configured')),
    );

    await expect(
      controller.handleLiveKitWebhook(undefined, request()),
    ).rejects.toMatchObject({
      status: 401,
      response: expect.objectContaining({
        message: 'LIVEKIT_WEBHOOK_INVALID',
      }),
    });
    expect(recordWebhook).toHaveBeenCalledWith('rejected');
  });

  it('answers 500 (so LiveKit retries) when a correctly signed event fails to process', async () => {
    // 验签已过的回调处理失败不是签名问题：以前一律 401，数据库一抖合法回调就被丢掉。
    const dbError = new Error('Connection terminated unexpectedly');
    const { controller } = controllerWith(jest.fn().mockRejectedValue(dbError));
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const failure = await controller
      .handleLiveKitWebhook('Bearer secret-webhook-jwt', request())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InternalServerErrorException);
    expect(failure).not.toBeInstanceOf(UnauthorizedException);
    expect((failure as InternalServerErrorException).getStatus()).toBe(500);
    expect((failure as InternalServerErrorException).getResponse()).toEqual(
      expect.objectContaining({ message: 'LIVEKIT_WEBHOOK_FAILED' }),
    );
    // 原始错误挂在 cause 上，Sentry 能看到真正的数据库错误。
    expect((failure as { cause?: unknown }).cause).toBe(dbError);

    expect(recordWebhook).toHaveBeenCalledTimes(1);
    expect(recordWebhook).toHaveBeenCalledWith('failed');

    expect(logError).toHaveBeenCalledTimes(1);
    const logged = String(logError.mock.calls[0][0]);
    expect(logged).toContain('call.webhook_failed');
    expect(logged).toContain('event=room_finished');
    expect(logged).toContain('room=circle_call_1');
    expect(logged).toContain('Connection terminated unexpectedly');
    expect(logged).not.toContain(rawBody);
    expect(logged).not.toContain('secret-webhook-jwt');
  });

  it('a throwing metrics recorder changes neither success nor rejection', async () => {
    recordWebhook.mockImplementation(() => {
      throw new Error('registry broken');
    });
    const ok = controllerWith(jest.fn().mockResolvedValue('handled'));

    await expect(
      ok.controller.handleLiveKitWebhook('Bearer token', request()),
    ).resolves.toEqual({ ok: true });

    const bad = controllerWith(
      jest.fn(),
      jest.fn().mockRejectedValue(new Error('bad signature')),
    );
    await expect(
      bad.controller.handleLiveKitWebhook('Bearer token', request()),
    ).rejects.toThrow(UnauthorizedException);
  });
});
