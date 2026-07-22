import { MembershipService } from './membership.service';

describe('MembershipService', () => {
  const service = new MembershipService();

  it('returns only VIP1 to VIP4 plans', () => {
    const plans = service.getPlans();

    expect(plans).toHaveLength(4);
    expect(plans.map((plan) => plan.level)).toEqual([1, 2, 3, 4]);
    expect(plans.map((plan) => plan.price)).toEqual([780, 1280, 2100, 4600]);
  });
});
