import { createHash } from 'crypto';
import { AuthController } from '../auth.controller';

const RAW_DEVICE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const DEVICE_KEY = createHash('sha256').update(RAW_DEVICE_ID).digest('hex');

function setup(
  boundKey: string | null,
  bindResult: { deviceName: string | null } | null = {
    deviceName: 'iPhone 16 Pro Max',
  },
) {
  const deviceTrust = {
    listPending: jest.fn().mockResolvedValue([]),
    trustOnRefresh: jest.fn().mockResolvedValue(undefined),
  };
  const refreshTokens = {
    findSessionDeviceKey: jest.fn().mockResolvedValue(boundKey),
    bindLegacySessionDevice: jest.fn().mockResolvedValue(bindResult),
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
  return { controller, deviceTrust, refreshTokens, req };
}

describe('login challenge approver identity', () => {
  it('uses the device bound to the session and never rebinds it', async () => {
    const { controller, deviceTrust, refreshTokens, req } = setup('bound-key');

    await controller.pendingLoginChallenges(req as never);

    expect(deviceTrust.listPending).toHaveBeenCalledWith('u1', 'bound-key');
    expect(refreshTokens.bindLegacySessionDevice).not.toHaveBeenCalled();
    expect(deviceTrust.trustOnRefresh).not.toHaveBeenCalled();
  });

  it('binds and trusts a pre-rollout session on first contact so it can approve right away', async () => {
    const { controller, deviceTrust, refreshTokens, req } = setup(null);

    await controller.pendingLoginChallenges(req as never);

    expect(refreshTokens.bindLegacySessionDevice).toHaveBeenCalledWith(
      'u1',
      's1',
      DEVICE_KEY,
    );
    // 这个请求不带设备名头：受信任记录沿用会话上登录时记下的设备名。
    expect(deviceTrust.trustOnRefresh).toHaveBeenCalledWith(
      'u1',
      DEVICE_KEY,
      expect.objectContaining({
        deviceKey: DEVICE_KEY,
        deviceName: 'iPhone 16 Pro Max',
      }),
    );
    expect(deviceTrust.listPending).toHaveBeenCalledWith('u1', DEVICE_KEY);
  });

  it('does not trust the header device when the session could not be bound', async () => {
    const { controller, deviceTrust, req } = setup(null, null);

    await controller.pendingLoginChallenges(req as never);

    expect(deviceTrust.trustOnRefresh).not.toHaveBeenCalled();
    expect(deviceTrust.listPending).toHaveBeenCalledWith('u1', DEVICE_KEY);
  });

  it('a legacy session without a device id header stays untrusted', async () => {
    const { controller, deviceTrust, refreshTokens, req } = setup(null);
    req.headers = {};

    await controller.pendingLoginChallenges(req as never);

    expect(refreshTokens.bindLegacySessionDevice).not.toHaveBeenCalled();
    expect(deviceTrust.listPending).toHaveBeenCalledWith('u1', null);
  });
});
