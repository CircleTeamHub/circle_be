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

  // 断开重连不能重置配额 —— 那正是把 key 从 socket.id 换成 userId 要堵的洞:
  // 客户端只要每发满就重连一次,限流等于不存在。
  it('pruneExpired keeps an in-window budget so reconnecting does not reset it', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('u1', 0)).toBe(true);
    // 断开:此刻窗口内还有记录,必须原样保留。
    limiter.pruneExpired('u1', 100);
    expect(limiter.tryAcquire('u1', 200)).toBe(false);
  });

  it('pruneExpired reclaims a key once its window has fully passed', () => {
    const limiter = new SlidingWindowRateLimiter(1, 1_000);
    expect(limiter.tryAcquire('u1', 0)).toBe(true);
    // 窗口整个过完再断开:回收,不占内存。
    limiter.pruneExpired('u1', 2_000);
    expect(limiter.tryAcquire('u1', 2_001)).toBe(true);
  });
});
