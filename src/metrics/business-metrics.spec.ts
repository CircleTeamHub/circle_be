import { createBusinessMetrics, OTHER_EVENT } from './business-metrics';

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

  it('bounds event-name cardinality so a misused label cannot explode series', async () => {
    const metrics = createBusinessMetrics();

    // Simulate a future caller accidentally passing a high-cardinality value.
    for (let i = 0; i < 500; i += 1) {
      metrics.recordEvent(`accidental_user_id_${i}`, 'success');
    }

    const text = await metrics.registry.metrics();
    const distinctEvents = new Set(
      [...text.matchAll(/business_events_total\{[^}]*event="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    );
    // 100 admitted distinct names + the OTHER bucket — not 500 series.
    expect(distinctEvents.size).toBeLessThanOrEqual(101);
    expect(distinctEvents.has(OTHER_EVENT)).toBe(true);
  });
});
