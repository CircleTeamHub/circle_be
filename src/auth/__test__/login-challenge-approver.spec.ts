import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthController } from '../auth.controller';

const RAW_DEVICE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function setup(boundKey: string | null) {
  const deviceTrust = {
    listPending: jest.fn().mockResolvedValue([]),
    trustOnRefresh: jest.fn().mockResolvedValue(undefined),
  };
  const refreshTokens = {
    findSessionDeviceKey: jest.fn().mockResolvedValue(boundKey),
  };
  const controller = new AuthController(
    {} as never,
    deviceTrust as never,
    refreshTokens as never,
  );
  const req = {
    user: { userId: 'u1', sessionId: 's1' },
    headers: { 'x-device-id': RAW_DEVICE_ID } as Record<string, string>,
    ip: '127.0.0.1',
  };
  return { controller, deviceTrust, req };
}

describe('login challenge approver identity', () => {
  it('uses the device bound to the session, ignoring the header', async () => {
    const { controller, deviceTrust, req } = setup('bound-key');

    await controller.pendingLoginChallenges(req as never);

    expect(deviceTrust.listPending).toHaveBeenCalledWith('u1', 'bound-key');
  });

  it('asks a pre-rollout session to refresh instead of trusting the header on an access token alone', async () => {
    const { controller, deviceTrust, req } = setup(null);

    await expect(
      controller.pendingLoginChallenges(req as never),
    ).rejects.toThrow(ConflictException);
    await expect(
      controller.pendingLoginChallenges(req as never),
    ).rejects.toMatchObject({
      response: { errorCode: 'AUTH_SESSION_DEVICE_UNBOUND' },
    });
    // 只凭 access token 绝不记信任：信任只在续签（持有 refresh token）时补记。
    expect(deviceTrust.trustOnRefresh).not.toHaveBeenCalled();
    expect(deviceTrust.listPending).not.toHaveBeenCalled();
  });

  it('an unbound session from an old client without a device id stays untrusted', async () => {
    const { controller, deviceTrust, req } = setup(null);
    req.headers = {};

    await controller.pendingLoginChallenges(req as never);

    expect(deviceTrust.listPending).toHaveBeenCalledWith('u1', null);
  });

  it('records the proxy-resolved IP, not a client-supplied X-Client-IP', async () => {
    const authService = { login: jest.fn().mockResolvedValue({}) };
    const controller = new AuthController(
      authService as never,
      {} as never,
      {} as never,
    );
    await controller.login(
      { identifier: 'a@b.c', password: 'secret12' } as never,
      {
        headers: { 'x-client-ip': '6.6.6.6', 'x-device-id': RAW_DEVICE_ID },
        ip: '203.0.113.9',
      } as never,
    );
    expect(authService.login).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ip: '203.0.113.9',
        deviceKey: createHash('sha256').update(RAW_DEVICE_ID).digest('hex'),
      }),
    );
  });
});
