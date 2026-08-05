import { MEMBERSHIP_CATALOG } from 'src/membership/membership.catalog';
import { CIRCLE_CREATE_LIMIT } from './circle-limits';

describe('circle limits', () => {
  it('keeps joined-circle limits in the membership catalog', () => {
    expect(
      MEMBERSHIP_CATALOG.map((tier) => tier.quotas.joinedCircles.actual),
    ).toEqual([100, 200, 300, 1000, 2000]);
  });

  it('keeps the created-circle limit at 20', () => {
    expect(CIRCLE_CREATE_LIMIT).toBe(20);
  });
});
