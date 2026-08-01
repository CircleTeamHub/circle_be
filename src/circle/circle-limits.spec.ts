import { MEMBERSHIP_CATALOG } from 'src/membership/membership.catalog';
import { CIRCLE_CREATE_LIMIT, CIRCLE_JOIN_LIMIT } from './circle-limits';

describe('circle limits', () => {
  it('advertises exactly the enforced join limit on every membership tier', () => {
    expect(MEMBERSHIP_CATALOG).not.toHaveLength(0);

    for (const tier of MEMBERSHIP_CATALOG) {
      // 目录只负责展示、circle-limits 负责执行。两者一旦漂移，会员中心就会
      // 宣传一个后端根本不放行的额度 —— 这条断言是唯一的防线。
      expect({
        key: tier.key,
        actual: tier.quotas.joinedCircles.actual,
        display: tier.quotas.joinedCircles.display,
      }).toEqual({
        key: tier.key,
        actual: CIRCLE_JOIN_LIMIT,
        display: String(CIRCLE_JOIN_LIMIT),
      });
    }
  });

  it('keeps both limits finite so neither write path is unbounded', () => {
    for (const limit of [CIRCLE_JOIN_LIMIT, CIRCLE_CREATE_LIMIT]) {
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });
});
