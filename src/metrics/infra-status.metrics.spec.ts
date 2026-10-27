import { createInfraStatusMetrics } from './infra-status.metrics';

describe('createInfraStatusMetrics', () => {
  it.each([
    [true, 1],
    [false, 0],
  ])('exports object store reachability %s as %s', async (reachable, value) => {
    const { registry } = createInfraStatusMetrics({
      objectStoreReachable: async () => reachable,
    });

    await expect(registry.metrics()).resolves.toContain(
      `circle_object_store_up ${value}`,
    );
  });

  it('exports 0 when the reachability check throws', async () => {
    const { registry } = createInfraStatusMetrics({
      objectStoreReachable: async () => {
        throw new Error('boom');
      },
    });

    await expect(registry.metrics()).resolves.toContain(
      'circle_object_store_up 0',
    );
  });

  it('does not register the reachability gauge when storage is disabled', async () => {
    // 没启用对象存储时恒 0 的 gauge 只会让 ObjectStoreUnreachable 对着一个本来就
    // 不存在的依赖长鸣 —— 与 Redis 的处理一致。
    const { registry } = createInfraStatusMetrics({
      objectStoreReachable: null,
    });

    await expect(registry.metrics()).resolves.not.toContain(
      'circle_object_store_up',
    );
  });

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
