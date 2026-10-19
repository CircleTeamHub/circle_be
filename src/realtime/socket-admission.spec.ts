import { SocketAdmission } from './socket-admission';
import { createGatewayMetrics } from '../metrics/gateway-metrics';

describe('WebSocket resource admission', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('bounds unauthenticated clients, releases timed-out reservations and closes them', () => {
    const budget = new SocketAdmission(3, 1, 1000);
    const close = jest.fn();
    expect(budget.acquire({}, close)).toBe(true);
    expect(budget.acquire({}, jest.fn())).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(budget.hasCapacity()).toBe(true);
    budget.destroy();
  });

  it('authenticated clients retain the total budget but free the pending budget', () => {
    const budget = new SocketAdmission(2, 1, 1000);
    const a = {},
      b = {};
    const close = jest.fn();
    budget.acquire(a, close);
    budget.authenticate(a);
    expect(budget.acquire(b, close)).toBe(true);
    budget.authenticate(b);
    expect(budget.acquire({}, close)).toBe(false);
    jest.advanceTimersByTime(2000);
    expect(close).not.toHaveBeenCalled();
    budget.release(a);
    budget.release(a);
    expect(budget.acquire({}, close)).toBe(true);
    budget.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});

it.each(['chat', 'realtime'] as const)(
  'exports accurate %s budgets, rejection and timeout metrics throughout the lifecycle',
  async (channel) => {
    jest.useFakeTimers();
    const metrics = createGatewayMetrics();
    const budget = new SocketAdmission(2, 1, 1000, channel, metrics);
    const a = {},
      b = {};
    try {
      budget.acquire(a, jest.fn());
      // Duplicate acquisition must not leak a slot or a timer.
      budget.acquire(a, jest.fn());
      budget.acquire(b, jest.fn());
      expect(await metrics.registry.metrics()).toContain(
        `circle_gateway_rejections_total{pool="${channel}_pending",reason="capacity"} 1`,
      );
      budget.authenticate(a);
      budget.acquire(b, jest.fn());
      budget.acquire({}, jest.fn());
      let text = await metrics.registry.metrics();
      expect(text).toContain(
        `circle_gateway_capacity_used{pool="${channel}_connections"} 2`,
      );
      expect(text).toContain(
        `circle_gateway_capacity_limit{pool="${channel}_connections"} 2`,
      );
      expect(text).toContain(
        `circle_gateway_capacity_used{pool="${channel}_pending"} 1`,
      );
      expect(text).toContain(
        `circle_gateway_rejections_total{pool="${channel}_connections",reason="capacity"} 1`,
      );
      jest.advanceTimersByTime(1000);
      budget.release(b); // The close event after timeout must be idempotent.
      text = await metrics.registry.metrics();
      expect(text).toContain(
        `circle_gateway_capacity_used{pool="${channel}_connections"} 1`,
      );
      expect(text).toContain(
        `circle_gateway_capacity_used{pool="${channel}_pending"} 0`,
      );
      expect(text).toContain(
        `circle_gateway_rejections_total{pool="${channel}_pending",reason="auth_timeout"} 1`,
      );
      budget.destroy();
      expect(await metrics.registry.metrics()).toContain(
        `circle_gateway_capacity_used{pool="${channel}_connections"} 0`,
      );
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      budget.destroy();
      jest.useRealTimers();
    }
  },
);
