import { gatewayMetrics } from '../metrics/gateway-metrics';

/** Per-process resource budget; edge rate limits separately bound requests per IP. */
export class SocketAdmission {
  private readonly connections = new Map<
    object,
    ReturnType<typeof setTimeout> | null
  >();
  private pending = 0;

  constructor(
    private readonly maxConnections = 2000,
    private readonly maxPending = 128,
    private readonly authTimeoutMs = 10_000,
    private readonly channel?: 'chat' | 'realtime',
    private readonly metrics = gatewayMetrics,
  ) {
    this.reportUsage();
  }

  private reportUsage(): void {
    if (!this.channel) return;
    this.metrics.setBudget(
      `${this.channel}_connections`,
      this.connections.size,
      this.maxConnections,
    );
    this.metrics.setBudget(
      `${this.channel}_pending`,
      this.pending,
      this.maxPending,
    );
  }

  hasCapacity(): boolean {
    let exhausted: 'connections' | 'pending' | null = null;
    if (this.connections.size >= this.maxConnections) exhausted = 'connections';
    else if (this.pending >= this.maxPending) exhausted = 'pending';
    if (exhausted && this.channel) {
      this.metrics.reject(`${this.channel}_${exhausted}`, 'capacity');
    }
    return exhausted === null;
  }

  acquire(connection: object, close: () => void): boolean {
    if (this.connections.has(connection)) return true;
    if (!this.hasCapacity()) return false;
    this.pending += 1;
    const timer = setTimeout(() => {
      if (this.channel)
        this.metrics.reject(`${this.channel}_pending`, 'auth_timeout');
      this.release(connection);
      close();
    }, this.authTimeoutMs);
    timer.unref?.();
    this.connections.set(connection, timer);
    this.reportUsage();
    return true;
  }

  authenticate(connection: object): void {
    const timer = this.connections.get(connection);
    if (!timer) return;
    clearTimeout(timer);
    this.pending -= 1;
    this.connections.set(connection, null);
    this.reportUsage();
  }

  release(connection: object): void {
    if (!this.connections.has(connection)) return;
    const timer = this.connections.get(connection);
    if (timer) {
      clearTimeout(timer);
      this.pending -= 1;
    }
    this.connections.delete(connection);
    this.reportUsage();
  }

  destroy(): void {
    for (const connection of this.connections.keys()) this.release(connection);
  }
}
