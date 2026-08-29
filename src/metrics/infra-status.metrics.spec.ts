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
});
