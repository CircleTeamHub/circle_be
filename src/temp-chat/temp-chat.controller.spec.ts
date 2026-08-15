import { BadRequestException } from '@nestjs/common';
import { TempChatController } from './temp-chat.controller';
import {
  GUEST_IMAGE_MAX_BYTES,
  GUEST_VIDEO_MAX_BYTES,
} from './dto/guest-presign.dto';

describe('TempChatController guest media uploads', () => {
  const uploadService = { presign: jest.fn() };
  const uploadQuota = { consume: jest.fn() };
  const controller = new TempChatController(
    {} as never,
    {} as never,
    uploadService as never,
    uploadQuota as never,
  );
  const request = {
    tempChatGuest: {
      guestId: 'guest-1',
      tcId: 'temp-1',
      conversationId: 'conv-1',
    },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    uploadService.presign.mockResolvedValue({ key: 'chat/guest-1/clip.mp4' });
    uploadQuota.consume.mockResolvedValue(undefined);
  });

  it('keeps the existing 10MB image limit', async () => {
    await expect(
      controller.guestUploadPresign(request, {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        sizeBytes: GUEST_IMAGE_MAX_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploadQuota.consume).not.toHaveBeenCalled();
    expect(uploadService.presign).not.toHaveBeenCalled();
  });

  it('allows a video up to the guest video limit and charges quota first', async () => {
    await controller.guestUploadPresign(request, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: GUEST_VIDEO_MAX_BYTES,
    });
    expect(uploadQuota.consume).toHaveBeenCalledWith(
      'guest-1',
      'temp-1',
      GUEST_VIDEO_MAX_BYTES,
    );
    expect(uploadService.presign).toHaveBeenCalledWith(
      'clip.mp4',
      'video/mp4',
      GUEST_VIDEO_MAX_BYTES,
      'chat',
      'guest-1',
    );
  });
});
