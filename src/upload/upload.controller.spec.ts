import { HttpStatus } from '@nestjs/common';
import { uploadMetrics } from 'src/metrics/upload-metrics';
import { RedisService } from 'src/redis/redis.service';
import { UPLOAD_FOLDERS } from './dto/presign.dto';
import { UploadController } from './upload.controller';
import { UploadLimitService } from './upload-limit.service';
import { PUBLIC_READ_UPLOAD_FOLDERS } from './upload.service';

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
  const uploadIntent = {
    track: jest.fn(),
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
      key: 'avatars/user-1/avatar.png',
      fileUrl: 'https://cdn.example/avatar.png',
    });
    uploadIntent.track.mockResolvedValue(undefined);
    redisService.isEnabled.mockReturnValue(true);
    redisService.incrementWithTtl.mockResolvedValue(1);
  });

  it('uses Redis to enforce a per-user presign limit when configured', async () => {
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
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
    redisService.incrementWithTtl.mockResolvedValue(41);
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
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
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    for (let index = 0; index < 40; index += 1) {
      await controller.presign(dto, req);
    }
    expect(uploadService.presign).toHaveBeenCalledTimes(40);

    // The 41st is throttled with 429 (not a 503 fail-closed).
    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(recordUploadPresignLimited).toHaveBeenCalledWith('memory');
  });

  it('keeps the local fallback limiter when Redis is not configured', async () => {
    redisService.isEnabled.mockReturnValue(false);
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    for (let index = 0; index < 40; index += 1) {
      await controller.presign(dto, req);
    }

    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(redisService.incrementWithTtl).not.toHaveBeenCalled();
    expect(uploadService.presign).toHaveBeenCalledTimes(40);
  });

  it('enforces the local fallback exactly under concurrent Redis failures', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    // Two waves: one wave must stay under the Redis in-flight bulkhead (32),
    // which is a separate gate and would otherwise reject before the counter.
    const wave = (length: number) =>
      Promise.allSettled(
        Array.from({ length }, () => controller.presign(dto, req)),
      );
    const results = [...(await wave(30)), ...(await wave(15))];

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(40);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(5);
    expect(uploadService.presign).toHaveBeenCalledTimes(40);
  });

  it('does not retry Redis on every request during its fallback cooldown', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
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
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
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
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    await expect(controller.presign(dto, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(uploadService.presign).not.toHaveBeenCalled();
  });

  // chat/notes 对象不在匿名可读白名单里,直连 403 —— 私有目录的 fileUrl 是 null,文档
  // 必须照实说清楚(既不能再叫「永久访问地址」,也不能让客户端以为还有链接可存)。
  it('documents fileUrl as null outside the public folders', () => {
    const operation = Reflect.getMetadata(
      'swagger/apiOperation',
      UploadController.prototype.presign,
    ) as { description?: string } | undefined;
    const description = operation?.description ?? '';

    for (const folder of PUBLIC_READ_UPLOAD_FOLDERS) {
      expect(description).toContain(folder);
    }
    const privateFolders = UPLOAD_FOLDERS.filter(
      (folder) =>
        !(PUBLIC_READ_UPLOAD_FOLDERS as readonly string[]).includes(folder),
    );
    expect(privateFolders).toEqual(['notes', 'chat', 'stickers']);
    for (const folder of privateFolders) {
      expect(description).toContain(folder);
    }
    expect(description).toContain('key');
    expect(description).toContain('null');
    expect(description).not.toContain('永久访问地址');
  });

  it('tracks a purpose-tagged presign before returning it', async () => {
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    await expect(
      controller.presign({ ...dto, purpose: 'PROFILE_AVATAR' }, req),
    ).resolves.toMatchObject({ key: 'avatars/user-1/avatar.png' });

    expect(uploadIntent.track).toHaveBeenCalledWith({
      objectKey: 'avatars/user-1/avatar.png',
      fileUrl: 'https://cdn.example/avatar.png',
      userID: 'user-1',
      purpose: 'PROFILE_AVATAR',
      folder: 'avatars',
      sizeBytes: 1024,
    });
  });

  it('does not track legacy presigns without a purpose', async () => {
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    await controller.presign(dto, req);

    expect(uploadIntent.track).not.toHaveBeenCalled();
  });

  it('fails the request when intent tracking fails', async () => {
    uploadIntent.track.mockRejectedValueOnce(new Error('intent write failed'));
    const controller = new UploadController(
      uploadService as any,
      new UploadLimitService(redisService as unknown as RedisService),
      uploadIntent as any,
    );

    await expect(
      controller.presign({ ...dto, purpose: 'PROFILE_AVATAR' }, req),
    ).rejects.toThrow('intent write failed');
  });
});
