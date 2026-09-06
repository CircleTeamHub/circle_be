import { createInfraStatusMetrics } from './infra-status.metrics';

describe('createInfraStatusMetrics', () => {
  it('raises the policy-unconfirmed gauge for externally managed storage', async () => {
    const { registry } = createInfraStatusMetrics({
      objectStoreStatus: () => 'external-unverified',
    });

    await expect(registry.metrics()).resolves.toContain(
      'circle_object_store_policy_unconfirmed 1',
    );
  });

  it('exposes a live production email-code bypass as an alertable gauge', async () => {
    const { registry } = createInfraStatusMetrics({
      emailCodeBypass: () => ({ status: 'active', identities: 2 }),
    });

    const metrics = await registry.metrics();

    expect(metrics).toContain('circle_email_code_bypass_active 1');
    expect(metrics).toContain('circle_email_code_bypass_identities 2');
  });

  it('separates a rejected bypass configuration from a live one', async () => {
    const { registry } = createInfraStatusMetrics({
      emailCodeBypass: () => ({
        status: 'misconfigured',
        identities: 0,
        reason: 'whatever',
      }),
    });

    const metrics = await registry.metrics();

    expect(metrics).toContain('circle_email_code_bypass_active 2');
    expect(metrics).toContain('circle_email_code_bypass_identities 0');
  });

  it('stays at zero when nothing configures a bypass', async () => {
    const { registry } = createInfraStatusMetrics({
      emailCodeBypass: () => ({ status: 'off', identities: 0 }),
    });

    await expect(registry.metrics()).resolves.toContain(
      'circle_email_code_bypass_active 0',
    );
  });
});
