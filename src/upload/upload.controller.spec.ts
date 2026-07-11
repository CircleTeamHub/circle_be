import { HttpStatus } from '@nestjs/common';
import { uploadMetrics } from 'src/metrics/upload-metrics';
import { RedisService } from 'src/redis/redis.service';
import { UploadController } from './upload.controller';

jest.mock('src/metrics/upload-metrics', () => ({
  uploadMetrics: {
    recordPresignLimited: jest.fn(),
    observePresign: jest.fn(),
  },
}));

const recordUploadPresignLimited =
  uploadMetrics.recordPresignLimited as jest.Mock;

describe('UploadController', () => {
  const uploadService = {
    presign: jest.fn(),
  };
  const redisService = {
    isEnabled: jest.fn(),
    incrementWithTtl: jest.fn(),
  };

  const req = {
    user: { userId: 'user-1' },
  } as any;
  const dto = {
    filename: 'avatar.png',
    contentType: 'image/png',
    sizeBytes: 1024,
    folder: 'avatars',
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    uploadService.presign.mockResolvedValue({
      uploadUrl: 'https://upload.example/avatar.png',
      fileUrl: 'https://cdn.example/avatar.png',
    });
    redisService.isEnabled.mockReturnValue(true);
    redisService.incrementWithTtl.mockResolvedValue(1);
  });

  it('uses Redis to enforce a per-user presign limit when configured', async () => {
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    await controller.presign(dto, req);

    expect(redisService.incrementWithTtl).toHaveBeenCalledWith(
      'rl:upload-presign:user:user-1',
      60,
    );
    expect(uploadService.presign).toHaveBeenCalledWith(
      'avatar.png',
      'image/png',
      1024,
      'avatars',
      'user-1',
    );
  });

  it('rejects presign requests after the Redis-backed user limit is exceeded', async () => {
    redisService.incrementWithTtl.mockResolvedValue(21);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(uploadService.presign).not.toHaveBeenCalled();
    expect(recordUploadPresignLimited).toHaveBeenCalledWith('redis');
  });

  it('falls back to in-memory limiting when Redis is configured but errors', async () => {
    // incrementWithTtl resolves null when Redis is unreachable: the limiter must
    // degrade to per-instance in-memory counting rather than fail the upload.
    redisService.incrementWithTtl.mockResolvedValue(null);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    for (let index = 0; index < 20; index += 1) {
      await controller.presign(dto, req);
    }
    expect(uploadService.presign).toHaveBeenCalledTimes(20);

    // The 21st is throttled with 429 (not a 503 fail-closed).
    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(recordUploadPresignLimited).toHaveBeenCalledWith('memory');
  });

  it('keeps the local fallback limiter when Redis is not configured', async () => {
    redisService.isEnabled.mockReturnValue(false);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    for (let index = 0; index < 20; index += 1) {
      await controller.presign(dto, req);
    }

    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(redisService.incrementWithTtl).not.toHaveBeenCalled();
    expect(uploadService.presign).toHaveBeenCalledTimes(20);
  });

  it('enforces the local fallback exactly under concurrent Redis failures', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => controller.presign(dto, req)),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(20);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(5);
    expect(uploadService.presign).toHaveBeenCalledTimes(20);
  });

  it('does not retry Redis on every request during its fallback cooldown', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    await controller.presign(dto, req);
    await controller.presign(dto, req);

    expect(redisService.incrementWithTtl).toHaveBeenCalledTimes(1);
  });

  it('releases the half-open probe when Redis unexpectedly rejects', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    redisService.incrementWithTtl
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValueOnce(1);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    await controller.presign(dto, req);
    now += 2_000;
    await expect(controller.presign(dto, req)).resolves.toBeDefined();
    now += 2_000;
    await expect(controller.presign(dto, req)).resolves.toBeDefined();

    expect(redisService.incrementWithTtl).toHaveBeenCalledTimes(4);
    nowSpy.mockRestore();
  });

  it('rejects when the shared daily issued-byte budget is exceeded', async () => {
    redisService.incrementWithTtl
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1024 * 1024 * 1024 + 1);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(uploadService.presign).not.toHaveBeenCalled();
  });
});
