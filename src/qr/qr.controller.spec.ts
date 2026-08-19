import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { RotateQrTokenDto } from './dto/qr.dto';
import { QrController } from './qr.controller';

describe('QrController', () => {
  it('exposes authenticated POST /tokens/rotate for the current user', async () => {
    const service = {
      rotateUserToken: jest.fn().mockResolvedValue({
        token: 'replacement-token',
        type: 'USER',
        expiresAt: null,
      }),
    };
    const controller = new QrController(service as any);

    await controller.rotate(
      { user: { userId: 'u1' } } as any,
      Object.assign(new RotateQrTokenDto(), { type: 'USER' }),
    );

    const handler = QrController.prototype.rotate;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('tokens/rotate');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(service.rotateUserToken).toHaveBeenCalledWith('u1');
  });

  it('accepts only USER as the rotation type', async () => {
    const valid = Object.assign(new RotateQrTokenDto(), { type: 'USER' });
    const invalid = Object.assign(new RotateQrTokenDto(), { type: 'GROUP' });

    await expect(validate(valid)).resolves.toHaveLength(0);
    await expect(validate(invalid)).resolves.not.toHaveLength(0);
  });
});
