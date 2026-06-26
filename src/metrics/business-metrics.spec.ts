import { createBusinessMetrics } from './business-metrics';

describe('createBusinessMetrics', () => {
  it('counts events by name and result', async () => {
    const metrics = createBusinessMetrics();

    metrics.recordEvent('auth_login', 'success');
    metrics.recordEvent('auth_login', 'success');
    metrics.recordEvent('auth_login', 'failure');

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /business_events_total\{[^}]*event="auth_login"[^}]*result="success"[^}]*\}\s+2/,
    );
    expect(text).toMatch(
      /business_events_total\{[^}]*result="failure"[^}]*\}\s+1/,
    );
  });

  it('isolates registries per instance', async () => {
    const a = createBusinessMetrics();
    const b = createBusinessMetrics();

    a.recordEvent('coin_gift', 'success');

    const textB = await b.registry.metrics();
    expect(textB).toContain('business_events_total');
    expect(textB).not.toMatch(/event="coin_gift"/);
  });
});
