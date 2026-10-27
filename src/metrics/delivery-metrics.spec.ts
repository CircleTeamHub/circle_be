import { createDeliveryMetrics } from './delivery-metrics';

describe('createDeliveryMetrics', () => {
  it('exports every provider/result combination at zero before the first delivery', async () => {
    // 从 0 开始导出：increase() 才能把进程启动后的第一批失败算进失败率。
    const output = await createDeliveryMetrics().registry.metrics();

    for (const provider of ['expo', 'jpush', 'apns_voip']) {
      for (const result of ['sent', 'retryable', 'dead_token', 'rejected']) {
        expect(output).toMatch(
          new RegExp(
            `circle_push_deliveries_total\\{provider="${provider}",result="${result}"\\} 0`,
          ),
        );
      }
    }
    for (const result of ['success', 'failure', 'unavailable']) {
      expect(output).toMatch(
        new RegExp(`circle_email_code_sends_total\\{result="${result}"\\} 0`),
      );
    }
  });

  it('counts push outcomes per provider and email sends per result', async () => {
    const metrics = createDeliveryMetrics();

    metrics.recordPushDelivery('jpush', 'retryable');
    metrics.recordPushDelivery('jpush', 'retryable');
    metrics.recordPushDelivery('expo', 'sent');
    metrics.recordEmailCodeSend('failure');

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_push_deliveries_total\{provider="jpush",result="retryable"\} 2/,
    );
    expect(output).toMatch(
      /circle_push_deliveries_total\{provider="expo",result="sent"\} 1/,
    );
    expect(output).toMatch(
      /circle_email_code_sends_total\{result="failure"\} 1/,
    );
  });
});
