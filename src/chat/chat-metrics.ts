import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type ChatAction = 'send' | 'read' | 'typing' | 'presence';
export type ChatEventResult = 'success' | 'failure' | 'rate_limited';
export type ChatBroadcastAction = 'message' | 'read' | 'typing' | 'presence';

export interface ChatMetrics {
  readonly registry: Registry;
  observeConnectionOpened(activeUsers: number): void;
  observeConnectionClosed(activeUsers: number): void;
  observeConnectionRejected(reason: 'per_user_limit' | 'join_failed'): void;
  observeAuthFailure(reason: 'rejected' | 'error'): void;
  observeEvent(action: ChatAction, result: ChatEventResult): void;
  observeAckDuration(
    action: 'send' | 'read' | 'presence',
    seconds: number,
  ): void;
  observeBroadcast(action: ChatBroadcastAction, seconds: number): void;
}

const CHAT_ACTIONS = new Set<ChatAction>([
  'send',
  'read',
  'typing',
  'presence',
]);
const CHAT_RESULTS = new Set<ChatEventResult>([
  'success',
  'failure',
  'rate_limited',
]);
const BROADCAST_ACTIONS = new Set<ChatBroadcastAction>([
  'message',
  'read',
  'typing',
  'presence',
]);

function boundedAction(action: string): ChatAction | undefined {
  return CHAT_ACTIONS.has(action as ChatAction)
    ? (action as ChatAction)
    : undefined;
}

function boundedResult(result: string): ChatEventResult | undefined {
  return CHAT_RESULTS.has(result as ChatEventResult)
    ? (result as ChatEventResult)
    : undefined;
}

function boundedBroadcastAction(
  action: string,
): ChatBroadcastAction | undefined {
  return BROADCAST_ACTIONS.has(action as ChatBroadcastAction)
    ? (action as ChatBroadcastAction)
    : undefined;
}

export function createChatMetrics(): ChatMetrics {
  const registry = new Registry();
  const connectionsActive = new Gauge({
    name: 'chat_connections_active',
    help: 'Active self-hosted chat sockets on this backend instance.',
    registers: [registry],
  });
  const usersOnline = new Gauge({
    name: 'chat_users_online',
    help: 'Distinct users with an active self-hosted chat socket on this instance.',
    registers: [registry],
  });
  const connectionEvents = new Counter({
    name: 'chat_connection_events_total',
    help: 'Self-hosted chat connection lifecycle events.',
    labelNames: ['event'],
    registers: [registry],
  });
  const connectionRejections = new Counter({
    name: 'chat_connection_rejections_total',
    help: 'Rejected self-hosted chat connections by bounded reason.',
    labelNames: ['reason'],
    registers: [registry],
  });
  const authFailures = new Counter({
    name: 'chat_auth_failures_total',
    help: 'Rejected self-hosted chat handshakes by bounded reason.',
    labelNames: ['reason'],
    registers: [registry],
  });
  const messagesReceived = new Counter({
    name: 'chat_messages_received_total',
    help: 'Client events received by the self-hosted chat gateway.',
    labelNames: ['action', 'result'],
    registers: [registry],
  });
  const ackDuration = new Histogram({
    name: 'chat_message_ack_duration_seconds',
    help: 'Time spent handling self-hosted chat events that have an ack.',
    labelNames: ['action'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const broadcastDuration = new Histogram({
    name: 'chat_broadcast_duration_seconds',
    help: 'Time spent handing a self-hosted chat event to Socket.IO.',
    labelNames: ['action'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

  return {
    registry,
    observeConnectionOpened(activeUsers) {
      connectionsActive.inc();
      usersOnline.set(Math.max(0, activeUsers));
      connectionEvents.inc({ event: 'opened' });
    },
    observeConnectionClosed(activeUsers) {
      connectionsActive.dec();
      usersOnline.set(Math.max(0, activeUsers));
      connectionEvents.inc({ event: 'closed' });
    },
    observeConnectionRejected(reason) {
      connectionRejections.inc({ reason });
    },
    observeAuthFailure(reason) {
      authFailures.inc({ reason });
    },
    observeEvent(action, result) {
      const safeAction = boundedAction(action);
      const safeResult = boundedResult(result);
      if (!safeAction || !safeResult) return;
      messagesReceived.inc({ action: safeAction, result: safeResult });
    },
    observeAckDuration(action, seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return;
      ackDuration.observe({ action }, seconds);
    },
    observeBroadcast(action, seconds) {
      const safeAction = boundedBroadcastAction(action);
      if (!safeAction || !Number.isFinite(seconds) || seconds < 0) return;
      broadcastDuration.observe({ action: safeAction }, seconds);
    },
  };
}

/** App-wide singleton merged into the backend `/metrics` endpoint. */
export const chatMetrics = createChatMetrics();
