import {
  resolveMembershipAppearance,
  toPublicMembershipAppearance,
} from './membership-appearance';

describe('membership appearance', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');

  it.each([
    [0, 'regular', 'default', null, false, false],
    [1, 'silver', 'silver', 'silver', true, false],
    [2, 'gold', 'gold', 'gold', true, false],
    [3, 'diamond', 'rainbow', 'diamond', true, false],
    [4, 'super', 'exclusive-shimmer', 'super-lifetime', true, true],
    [5, 'super', 'exclusive-shimmer', 'super-lifetime', true, true],
  ])(
    'maps stored level %i to its effective public appearance',
    (vipLevel, key, nameColor, badge, active, lifetime) => {
      expect(
        resolveMembershipAppearance({ vipLevel, vipExpiresAt: null }, now),
      ).toEqual({
        effectiveLevel: vipLevel >= 4 ? 4 : vipLevel,
        key,
        appearance: { nameColor, badge },
        active,
        lifetime,
      });
    },
  );

  it.each([1, 2, 3])(
    'makes expired level %i regular at the exact boundary',
    (vipLevel) => {
      expect(
        resolveMembershipAppearance({ vipLevel, vipExpiresAt: now }, now),
      ).toEqual({
        effectiveLevel: 0,
        key: 'regular',
        appearance: { nameColor: 'default', badge: null },
        active: false,
        lifetime: false,
      });
    },
  );

  it('keeps owner-only status fields out of the reusable public contract', () => {
    expect(
      toPublicMembershipAppearance({ vipLevel: 3, vipExpiresAt: null }, now),
    ).toEqual({
      effectiveLevel: 3,
      key: 'diamond',
      appearance: { nameColor: 'rainbow', badge: 'diamond' },
    });
  });
});
