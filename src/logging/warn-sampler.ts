import { performance } from 'node:perf_hooks';

type SampleWindow = {
  until: number;
  emitted: number;
  suppressed: number;
  onSuppressed: (count: number) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Per-key log sampling for lines a client can trigger at will (rejected
 * handshakes, bad auth frames): at most `perWindow` lines per key per window.
 * Sampling is acceptable, silent dropping is not — whatever a window dropped is
 * reported once when it ends, even if that key never logs again (a burst that
 * simply stops would otherwise vanish without a trace).
 *
 * Windows run on a monotonic clock, so a wall-clock step cannot stall a key.
 */
export class WarnSampler {
  private readonly windows = new Map<string, SampleWindow>();

  constructor(
    private readonly perWindow: number,
    readonly windowMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Whether to log this occurrence of `key`. When this window has dropped
   * lines, `onSuppressed` runs once with their count at the window's end (from
   * a timer, or right here if the window is already over).
   */
  admit(key: string, onSuppressed: (count: number) => void): boolean {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.until <= now) {
      if (window) this.report(window);
      window = {
        until: now + this.windowMs,
        emitted: 0,
        suppressed: 0,
        onSuppressed,
        timer: undefined,
      };
      this.windows.set(key, window);
    }
    if (window.emitted >= this.perWindow) {
      window.suppressed += 1;
      window.onSuppressed = onSuppressed;
      if (!window.timer) {
        const pending = window;
        pending.timer = setTimeout(
          () => this.report(pending),
          Math.max(0, pending.until - now),
        );
        pending.timer.unref?.();
      }
      return false;
    }
    window.emitted += 1;
    return true;
  }

  /** Stops pending end-of-window reports (module shutdown). */
  dispose(): void {
    for (const window of this.windows.values()) {
      if (window.timer) clearTimeout(window.timer);
      window.timer = undefined;
    }
    this.windows.clear();
  }

  private report(window: SampleWindow): void {
    if (window.timer) clearTimeout(window.timer);
    window.timer = undefined;
    if (window.suppressed === 0) return;
    const count = window.suppressed;
    window.suppressed = 0;
    window.onSuppressed(count);
  }
}
