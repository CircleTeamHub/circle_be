import { randomUUID } from 'node:crypto';

/**
 * Per-connection correlation ID for the WebSocket gateways (/chat-ws and
 * /realtime). Caddy sets this header to `ws-{request uuid}` on the upgrade
 * request (deploy/Caddyfile.admin) and overwrites whatever the client sent, so
 * behind the edge the value is trusted. Anything that does not look like one
 * of those — a direct client, a missing header — gets a fresh server-side ID.
 * Auth payloads are client-controlled and must never become log correlation
 * identifiers.
 */
export const CONNECTION_TRACE_HEADER = 'x-connection-trace-id';

const SAFE_CONNECTION_TRACE_ID =
  /^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function safeConnectionTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CONNECTION_TRACE_ID.test(value)
    ? value
    : undefined;
}

export function resolveConnectionTraceId(trustedProxyValue: unknown): string {
  return safeConnectionTraceId(trustedProxyValue) ?? `ws-${randomUUID()}`;
}
