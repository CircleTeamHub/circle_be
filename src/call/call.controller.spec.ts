import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CallController } from './call.controller';

describe('CallController', () => {
  it('requires authentication and throttling', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CallController);
    const createGroup = CallController.prototype.createGroupCall;

    expect(guards).toEqual([ThrottlerGuard, JwtGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', createGroup)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', createGroup)).toBe(60_000);
  });

  it('passes group call creation through with the current user', async () => {
    const service = {
      createGroupCall: jest.fn().mockResolvedValue({ id: 'call-1' }),
    };
    const controller = new CallController(service as any);

    await controller.createGroupCall(
      {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      },
      { user: { userId: 'user-1' } } as any,
    );

    expect(service.createGroupCall).toHaveBeenCalledWith('user-1', {
      conversationID: 'sg_group-1',
      callType: 'AUDIO',
      inviteeIDs: ['user-2'],
    });
  });

  it('passes accept, reject, leave, cancel, and join-token calls through', async () => {
    const service = {
      acceptCall: jest.fn().mockResolvedValue({}),
      rejectCall: jest.fn().mockResolvedValue({}),
      leaveCall: jest.fn().mockResolvedValue({}),
      cancelCall: jest.fn().mockResolvedValue({}),
      createJoinToken: jest.fn().mockResolvedValue({}),
    };
    const controller = new CallController(service as any);
    const req = { user: { userId: 'user-2' } } as any;

    await controller.acceptCall('call-1', req);
    await controller.rejectCall('call-1', req);
    await controller.leaveCall('call-1', { reason: 'NORMAL' }, req);
    await controller.cancelCall('call-1', req);
    await controller.createJoinToken('call-1', req);

    expect(service.acceptCall).toHaveBeenCalledWith('user-2', 'call-1');
    expect(service.rejectCall).toHaveBeenCalledWith('user-2', 'call-1');
    expect(service.leaveCall).toHaveBeenCalledWith('user-2', 'call-1');
    expect(service.cancelCall).toHaveBeenCalledWith('user-2', 'call-1');
    expect(service.createJoinToken).toHaveBeenCalledWith('user-2', 'call-1');
  });
});
