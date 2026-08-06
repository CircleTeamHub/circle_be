import { SlidingWindowRateLimiter } from './chat-rate-limiter';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to limit within the window and rejects the overflow', () => {
    const limiter = new SlidingWindowRateLimiter(3, 1_000);
    expect(limiter.tryAcquire('s1', 0)).toBe(true);
    expect(limiter.tryAcquire('s1', 100)).toBe(true);
    expect(limiter.tryAcquire('s1', 200)).toBe(true);
    expect(limiter.tryAcquire('s1', 300)).toBe(false);
  });

  it('slides: entries older than the window free capacity', () => {
    const limiter = new SlidingWindowRateLimiter(2, 1_000);
    expect(limiter.tryAcquire('s1', 0)).toBe(true);
    expect(limiter.tryAcquire('s1', 500)).toBe(true);
    expect(limiter.tryAcquire('s1', 900)).toBe(false);
    // t=1100:t=0 的记录滑出窗口,腾出一个名额。
    expect(limiter.tryAcquire('s1', 1_100)).toBe(true);
    expect(limiter.tryAcquire('s1', 1_200)).toBe(false);
  });

  it('isolates keys from each other', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('a', 0)).toBe(true);
    expect(limiter.tryAcquire('b', 0)).toBe(true);
    expect(limiter.tryAcquire('a', 1)).toBe(false);
  });

  it('rejected attempts do not consume capacity', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('s1', 0)).toBe(true);
    expect(limiter.tryAcquire('s1', 100)).toBe(false);
    // 若被拒的尝试也计数,这里会一直 false;正确行为是窗口滑过后放行。
    expect(limiter.tryAcquire('s1', 1_050)).toBe(true);
  });

  it('clear removes all state for a key', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('s1', 0)).toBe(true);
    limiter.clear('s1');
    expect(limiter.tryAcquire('s1', 1)).toBe(true);
  });
});
