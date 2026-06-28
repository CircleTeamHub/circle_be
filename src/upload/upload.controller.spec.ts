import { HttpException, HttpStatus } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { UploadController } from './upload.controller';

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
  });

  it('fails closed when Redis is configured but unavailable', async () => {
    redisService.incrementWithTtl.mockResolvedValue(null);
    const controller = new UploadController(
      uploadService as any,
      redisService as unknown as RedisService,
    );

    const result = controller.presign(dto, req);

    await expect(result).rejects.toThrow(HttpException);
    await expect(result).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
    expect(uploadService.presign).not.toHaveBeenCalled();
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
});
