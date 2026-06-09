import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { OutboxController } from './outbox.controller';

describe('OutboxController', () => {
  it('requires jwt and admin guards', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OutboxController);

    expect(guards).toEqual([JwtGuard, AdminGuard]);
  });

  it('returns outbox health from the service', async () => {
    const service = { getHealth: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new OutboxController(service as any);

    await expect(controller.getHealth()).resolves.toEqual({ ok: true });
    expect(service.getHealth).toHaveBeenCalled();
  });
});
