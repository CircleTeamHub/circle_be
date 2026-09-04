import { ServiceUnavailableException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveKitCallService } from './livekit.service';

describe('LiveKitCallService', () => {
  function decodeToken(token: string): Record<string, any> {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  }

  function buildService(env: Record<string, string | undefined>) {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    return new LiveKitCallService(config);
  }

  it('rejects token minting when LiveKit is not configured', async () => {
    const service = buildService({});

    await expect(
      service.mintJoinToken({
        identity: 'user-1',
        name: 'Alice',
        roomName: 'circle_call_1',
        callType: 'AUDIO',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('mints microphone-only tokens for audio calls', async () => {
    const service = buildService({
      LIVEKIT_URL: 'wss://livekit.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
      LIVEKIT_TOKEN_TTL_SECONDS: '600',
    });

    const token = await service.mintJoinToken({
      identity: 'user-1',
      name: 'Alice',
      roomName: 'circle_call_1',
      callType: 'AUDIO',
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(decodeToken(token).video).toEqual(
      expect.objectContaining({
        room: 'circle_call_1',
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishSources: ['microphone'],
      }),
    );
    expect(service.getClientUrl()).toBe('wss://livekit.example.com');
  });

  it('mints publish tokens for video calls', async () => {
    const service = buildService({
      LIVEKIT_URL: 'wss://livekit.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
    });

    const token = await service.mintJoinToken({
      identity: 'user-1',
      roomName: 'circle_call_1',
      callType: 'VIDEO',
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(decodeToken(token).video).toEqual(
      expect.objectContaining({
        room: 'circle_call_1',
        roomJoin: true,
        canPublishSources: ['microphone', 'camera'],
      }),
    );
  });

  it('verifies and parses LiveKit webhook payloads', async () => {
    const service = buildService({
      LIVEKIT_URL: 'wss://livekit.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
    });
    const receive = jest.fn().mockResolvedValue({ event: 'room_finished' });
    (service as any).webhookReceiver = { receive };

    await expect(
      service.verifyWebhook('{"event":"room_finished"}', 'Bearer token'),
    ).resolves.toEqual({ event: 'room_finished' });

    expect(receive).toHaveBeenCalledWith(
      '{"event":"room_finished"}',
      'Bearer token',
    );
  });

  it('rejects webhook verification when LiveKit is not configured', async () => {
    const service = buildService({});

    await expect(service.verifyWebhook('{}', 'Bearer token')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('swallows room deletion errors because business state is already terminal', async () => {
    const service = buildService({
      LIVEKIT_URL: 'wss://livekit.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
    });
    jest.spyOn(service, 'deleteRoom').mockResolvedValueOnce(undefined);

    await expect(service.deleteRoom('circle_call_1')).resolves.toBeUndefined();
  });
});

describe('LiveKitCallService external-call logging', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      LOG_ON: 'true',
      EXTERNAL_LOG_ON: 'true',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('logs external_call_failed and surfaces a 503 when room creation fails', async () => {
    const env: Record<string, string> = {
      LIVEKIT_URL: 'wss://livekit.example.com',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
    };
    const service = new LiveKitCallService({
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).roomService, 'createRoom')
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:7880'));

    await expect(
      service.createRoom({ name: 'circle_call_1', maxParticipants: 4 }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'external_call_failed',
        service: 'livekit',
        operation: 'create_room',
        errorName: 'Error',
      }),
      'ExternalService',
    );
  });
});
