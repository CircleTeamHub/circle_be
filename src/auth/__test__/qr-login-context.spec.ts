import {
  describeQrLoginDevice,
  qrLoginVerificationCode,
} from '../qr-login-context';

describe('QR login confirmation context', () => {
  it('derives only a coarse browser and OS label', () => {
    expect(
      describeQrLoginDevice({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140.0',
        ip: '203.0.113.8',
      }),
    ).toBe('Microsoft Edge · Windows');
  });

  it('produces a stable six-digit comparison code', () => {
    const token = 'q'.repeat(32);
    expect(qrLoginVerificationCode(token)).toMatch(/^\d{6}$/);
    expect(qrLoginVerificationCode(token)).toBe(qrLoginVerificationCode(token));
    expect(qrLoginVerificationCode('r'.repeat(32))).not.toBe(
      qrLoginVerificationCode(token),
    );
  });
});
