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

  // 典型的一次性用户:发一条就断开。断开那一刻记录还在窗口内,pruneExpired 会
  // 保留 key,此后再没有东西回来看它 —— 没有全局清扫的话,长跑实例按历史用户数
  // 单调增长,四个限流器各存一份,和"有界内存"的初衷正好相反。
  it('reclaims one-shot users without requiring them to reconnect', () => {
    const limiter = new SlidingWindowRateLimiter(5, 1_000);
    for (let i = 0; i < 500; i += 1) {
      expect(limiter.tryAcquire(`one-shot-${i}`, 0)).toBe(true);
      limiter.pruneExpired(`one-shot-${i}`, 0); // 断开:此刻记录仍新鲜,必须保留
    }
    expect(limiter.size()).toBe(500);

    // 窗口过完之后任意一次活动都会触发清扫,不依赖那 500 个人回来。
    limiter.tryAcquire('someone-else', 120_000);

    expect(limiter.size()).toBe(1);
  });

  // 清扫不能顺手把活跃窗口内的 key 清掉 —— 那正是"断开重连不重置配额"赖以成立的。
  it('sweeping never drops a budget that is still inside its window', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    // t=0 的这条只是把清扫计时器起点钉在 0。
    limiter.tryAcquire('stale', 0);
    // t=59s:配额用掉,此刻距下次清扫还差 1s。
    expect(limiter.tryAcquire('active', 59_000)).toBe(true);
    // t=61s:清扫触发(距上次 61s ≥ 窗口),cutoff=1s —— 'stale' 出局,
    // 而 'active' 的记录只有 2s 大,必须活下来。
    limiter.tryAcquire('other', 61_000);
    // 因此紧接着再发仍应被拒:配额没有被清扫偷偷还给他。
    expect(limiter.tryAcquire('active', 61_500)).toBe(false);
  });
});
