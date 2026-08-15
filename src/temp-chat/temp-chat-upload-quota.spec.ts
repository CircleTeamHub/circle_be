import { HttpException } from '@nestjs/common';
import { TempChatUploadQuota } from './temp-chat-upload-quota';
import {
  GUEST_IMAGE_MAX_BYTES,
  GUEST_VIDEO_MAX_BYTES,
} from './dto/guest-presign.dto';

const MIB = 1024 * 1024;

describe('TempChatUploadQuota', () => {
  // 这两个数原本按 10 MiB 图片定(60 MiB = 6 张)。访客视频放到 50 MiB 之后
  // 它就变成「每个访客只能发一条视频」—— 第二条 429,功能等于没上。
  // 钉住「额度按单文件上限推导」这个关系,而不是钉住某个具体数字。
  it('keeps the guest ceiling in step with the single-file caps', async () => {
    expect(TempChatUploadQuota.GUEST_BYTES_LIMIT).toBeGreaterThanOrEqual(
      3 * GUEST_VIDEO_MAX_BYTES,
    );
    expect(TempChatUploadQuota.ROOM_BYTES_LIMIT).toBeGreaterThanOrEqual(
      TempChatUploadQuota.GUEST_BYTES_LIMIT,
    );

    const quota = new TempChatUploadQuota();
    // 满额视频连发三条 + 一张满额图片都不该被额度挡住。
    for (let i = 0; i < 3; i += 1) {
      await expect(
        quota.consume('g1', 'tc-1', GUEST_VIDEO_MAX_BYTES),
      ).resolves.toBeUndefined();
    }
    await expect(
      quota.consume('g1', 'tc-1', GUEST_IMAGE_MAX_BYTES),
    ).resolves.toBeUndefined();
  });

  describe('in-memory fallback (no Redis configured)', () => {
    it('lets a guest spend up to its byte ceiling, then refuses', async () => {
      const quota = new TempChatUploadQuota();
      // 取整分片:上限跟着单文件上限走之后不再保证能被 6 整除,
      // 用浮点份额会让第 6 次因为尾数误差就越界。
      const spend = Math.floor(TempChatUploadQuota.GUEST_BYTES_LIMIT / 6);
      for (let i = 0; i < 6; i += 1) {
        await expect(
          quota.consume('g1', 'tc-1', spend),
        ).resolves.toBeUndefined();
      }
      // 第七份越过上限:授权不再发放,匿名访客的申请面被封住。
      await expect(quota.consume('g1', 'tc-1', spend)).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('meters guests independently', async () => {
      const quota = new TempChatUploadQuota();
      await quota.consume('g1', 'tc-1', TempChatUploadQuota.GUEST_BYTES_LIMIT);
      await expect(quota.consume('g1', 'tc-1', 1)).rejects.toBeInstanceOf(
        HttpException,
      );
      // 同房间的另一名访客不受影响。
      await expect(quota.consume('g2', 'tc-1', MIB)).resolves.toBeUndefined();
    });

    it('caps the room even when each guest stays under its own ceiling', async () => {
      const quota = new TempChatUploadQuota();
      const perGuest = TempChatUploadQuota.GUEST_BYTES_LIMIT;
      const guestsToFillRoom = Math.ceil(
        TempChatUploadQuota.ROOM_BYTES_LIMIT / perGuest,
      );
      for (let i = 0; i < guestsToFillRoom; i += 1) {
        await quota.consume(`g${i}`, 'tc-1', perGuest).catch(() => undefined); // 最后一位可能正好把房间打满
      }
      await expect(
        quota.consume('fresh-guest', 'tc-1', MIB),
      ).rejects.toBeInstanceOf(HttpException);
      // 另一个房间仍可正常发图。
      await expect(
        quota.consume('fresh-guest', 'tc-2', MIB),
      ).resolves.toBeUndefined();
    });

    it('reports 429 with the temp-chat quota code', async () => {
      const quota = new TempChatUploadQuota();
      await quota.consume('g1', 'tc-1', TempChatUploadQuota.GUEST_BYTES_LIMIT);
      await expect(quota.consume('g1', 'tc-1', 1)).rejects.toMatchObject({
        status: 429,
        response: { errorCode: 'TEMP_CHAT_UPLOAD_QUOTA_EXCEEDED' },
      });
    });
  });

  describe('redis path', () => {
    it('counts through Redis when it is enabled', async () => {
      const redis = {
        isEnabled: () => true,
        incrementWithTtl: jest.fn().mockResolvedValue(1),
      };
      const quota = new TempChatUploadQuota(redis as never);
      await quota.consume('g1', 'tc-1', MIB);
      expect(redis.incrementWithTtl).toHaveBeenCalledWith(
        'tc-upload-bytes:guest:g1',
        TempChatUploadQuota.WINDOW_SECONDS,
        MIB,
      );
      expect(redis.incrementWithTtl).toHaveBeenCalledWith(
        'tc-upload-bytes:room:tc-1',
        TempChatUploadQuota.WINDOW_SECONDS,
        MIB,
      );
    });

    it('refuses once the Redis counter passes the ceiling', async () => {
      const redis = {
        isEnabled: () => true,
        incrementWithTtl: jest
          .fn()
          .mockResolvedValue(TempChatUploadQuota.GUEST_BYTES_LIMIT + 1),
      };
      const quota = new TempChatUploadQuota(redis as never);
      await expect(quota.consume('g1', 'tc-1', MIB)).rejects.toBeInstanceOf(
        HttpException,
      );
    });

    it('degrades to in-memory instead of failing the upload when Redis errors', async () => {
      const redis = {
        isEnabled: () => true,
        incrementWithTtl: jest.fn().mockRejectedValue(new Error('redis down')),
      };
      const quota = new TempChatUploadQuota(redis as never);
      // 计数层不可用不该把发图整条打死,但配额仍在本实例生效。
      await expect(quota.consume('g1', 'tc-1', MIB)).resolves.toBeUndefined();
      await expect(
        quota.consume('g1', 'tc-1', TempChatUploadQuota.GUEST_BYTES_LIMIT),
      ).rejects.toBeInstanceOf(HttpException);
    });
  });
});
