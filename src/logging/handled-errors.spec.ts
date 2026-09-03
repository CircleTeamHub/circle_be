import {
  markErrorCaptured,
  markSecurityEventLogged,
  wasErrorCaptured,
  wasSecurityEventLogged,
} from './handled-errors';

describe('handled-errors markers', () => {
  it('tracks capture and security-log state per exception instance', () => {
    const first = new Error('a');
    const second = new Error('b');

    expect(wasErrorCaptured(first)).toBe(false);
    markErrorCaptured(first);
    expect(wasErrorCaptured(first)).toBe(true);
    expect(wasErrorCaptured(second)).toBe(false);

    expect(wasSecurityEventLogged(first)).toBe(false);
    markSecurityEventLogged(first);
    expect(wasSecurityEventLogged(first)).toBe(true);
    // The two ledgers are independent.
    expect(wasErrorCaptured(second)).toBe(false);
    expect(wasSecurityEventLogged(second)).toBe(false);
  });

  it('ignores primitives without throwing (a thrown string cannot be tracked)', () => {
    expect(() => markErrorCaptured('boom')).not.toThrow();
    expect(() => markSecurityEventLogged(42)).not.toThrow();
    expect(wasErrorCaptured('boom')).toBe(false);
    expect(wasSecurityEventLogged(null)).toBe(false);
  });
});
