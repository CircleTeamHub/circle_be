import { createChatMetrics } from './chat-metrics';

describe('ChatMetrics', () => {
  it('records connection, traffic, latency, and rejection signals', async () => {
    const metrics = createChatMetrics();

    metrics.observeConnectionOpened(3);
    metrics.observeConnectionClosed(2);
    metrics.observeConnectionRejected('per_user_limit');
    metrics.observeAuthFailure('rejected');
    metrics.observeEvent('send', 'success');
    metrics.observeEvent('send', 'rate_limited');
    metrics.observeAckDuration('send', 0.025);
    metrics.observeBroadcast('message', 0.01);

    const output = await metrics.registry.metrics();

    expect(output).toMatch(/chat_connections_active\s+0/);
    expect(output).toMatch(/chat_users_online\s+2/);
    expect(output).toMatch(
      /chat_connection_rejections_total\{reason="per_user_limit"\}\s+1/,
    );
    expect(output).toMatch(/chat_auth_failures_total\{reason="rejected"\}\s+1/);
    expect(output).toMatch(
      /chat_messages_received_total\{action="send",result="success"\}\s+1/,
    );
    expect(output).toMatch(
      /chat_messages_received_total\{action="send",result="rate_limited"\}\s+1/,
    );
    expect(output).toMatch(
      /chat_message_ack_duration_seconds_count\{action="send"\}\s+1/,
    );
    expect(output).toMatch(
      /chat_broadcast_duration_seconds_count\{action="message"\}\s+1/,
    );
  });

  it('keeps event labels bounded to the supported action set', async () => {
    const metrics = createChatMetrics();

    metrics.observeEvent('send', 'success');
    metrics.observeEvent('unexpected-action' as never, 'success');

    const output = await metrics.registry.metrics();

    expect(output).toContain('action="send"');
    expect(output).not.toContain('unexpected-action');
  });
});
