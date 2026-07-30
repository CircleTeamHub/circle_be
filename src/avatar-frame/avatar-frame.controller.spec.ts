import { GUARDS_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AvatarFrameController } from './avatar-frame.controller';
import { AvatarFrameService } from './avatar-frame.service';
import { UpdateEquippedAvatarFrameDto } from './dto/avatar-frame.dto';

describe('AvatarFrameController', () => {
  const service = {
    getInventory: jest.fn(),
    setEquipped: jest.fn(),
  };
  const controller = new AvatarFrameController(
    service as unknown as AvatarFrameService,
  );
  const request = {
    user: {
      userId: 'authenticated-user',
      accountId: 'account-1',
      role: 'USER',
    },
  } as never;

  beforeEach(() => jest.clearAllMocks());

  it('guards every wardrobe route with JwtGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AvatarFrameController,
    ) as unknown[];

    expect(guards).toContain(JwtGuard);
  });

  it('gets inventory for the authenticated user only', async () => {
    service.getInventory.mockResolvedValue({
      equippedFrameId: null,
      items: [],
    });

    await controller.getMine(request);

    expect(service.getInventory).toHaveBeenCalledWith('authenticated-user');
  });

  it.each([['10000000-0000-4000-8000-000000000001'], [null]])(
    'updates the authenticated user selection with frameId %p',
    async (frameId) => {
      service.setEquipped.mockResolvedValue({
        equippedFrameId: frameId,
        items: [],
      });

      await controller.updateEquipped({ frameId }, request);

      expect(service.setEquipped).toHaveBeenCalledWith(
        'authenticated-user',
        frameId,
      );
    },
  );

  it('validates frameId as an explicit UUID or null', async () => {
    const missing = new UpdateEquippedAvatarFrameDto();
    const invalid = Object.assign(new UpdateEquippedAvatarFrameDto(), {
      frameId: 'not-a-uuid',
    });
    const cleared = Object.assign(new UpdateEquippedAvatarFrameDto(), {
      frameId: null,
    });

    await expect(validate(missing)).resolves.not.toHaveLength(0);
    await expect(validate(invalid)).resolves.not.toHaveLength(0);
    await expect(validate(cleared)).resolves.toHaveLength(0);
  });
});
