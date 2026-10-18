import { Counter, Gauge, Registry } from 'prom-client';

export type GatewayPool =
  | 'http'
  | 'chat_connections'
  | 'chat_pending'
  | 'realtime_connections'
  | 'realtime_pending';
export type GatewayRejection = 'capacity' | 'auth_timeout';

/** Fixed labels only: never add IPs, tokens, user IDs or request paths. */
export function createGatewayMetrics() {
  const registry = new Registry();
  const used = new Gauge({
    name: 'circle_gateway_capacity_used',
    help: 'Resources currently held in a per-process gateway budget.',
    labelNames: ['pool'],
    registers: [registry],
  });
  const limit = new Gauge({
    name: 'circle_gateway_capacity_limit',
    help: 'Configured per-process gateway budget.',
    labelNames: ['pool'],
    registers: [registry],
  });
  const rejected = new Counter({
    name: 'circle_gateway_rejections_total',
    help: 'Gateway capacity rejections and unauthenticated socket timeouts.',
    labelNames: ['pool', 'reason'],
    registers: [registry],
  });
  return {
    registry,
    setBudget(pool: GatewayPool, active: number, maximum: number) {
      used.set({ pool }, active);
      limit.set({ pool }, maximum);
    },
    reject(pool: GatewayPool, reason: GatewayRejection) {
      rejected.inc({ pool, reason });
    },
  };
}

export const gatewayMetrics = createGatewayMetrics();
