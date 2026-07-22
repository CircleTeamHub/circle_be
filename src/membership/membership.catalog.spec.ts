import {
  MEMBERSHIP_CATALOG,
  addUtcCalendarMonths,
  resolveEffectiveMembershipLevel,
} from './membership.catalog';

describe('membership catalog', () => {
  it.each([
    {
      level: 0,
      key: 'regular',
      durationMonths: null,
      priceCny: null,
      actual: [100, 100, 50, 1],
      display: ['100', '100', '50', '1'],
      appearance: ['default', null, null],
    },
    {
      level: 1,
      key: 'silver',
      durationMonths: 1,
      priceCny: 298,
      actual: [300, 200, 100, 5],
      display: ['300', '200', '100', '5'],
      appearance: ['silver', 'silver', null],
    },
    {
      level: 2,
      key: 'gold',
      durationMonths: 6,
      priceCny: 1288,
      actual: [500, 500, 500, 20],
      display: ['500', '500', '500', '20'],
      appearance: ['gold', 'gold', null],
    },
    {
      level: 3,
      key: 'diamond',
      durationMonths: 12,
      priceCny: 1998,
      actual: [1000, 1000, 1000, 50],
      display: ['1000', '999+', '999+', '50'],
      appearance: ['rainbow', 'diamond', 'standard'],
    },
    {
      level: 4,
      key: 'super',
      durationMonths: null,
      priceCny: 3998,
      actual: [3000, 5000, 10000, 1000],
      display: ['3000', 'unlimited', 'unlimited', 'unlimited'],
      appearance: ['exclusive-shimmer', 'super-lifetime', 'premium'],
    },
  ])(
    'defines the complete $key actual and display entitlement contract',
    ({ level, key, durationMonths, priceCny, actual, display, appearance }) => {
      const tier = MEMBERSHIP_CATALOG[level];

      expect(tier.key).toBe(key);
      expect(tier.durationMonths).toBe(durationMonths);
      expect(tier.priceCny).toBe(priceCny);
      expect([
        tier.quotas.groupMembers.actual,
        tier.quotas.joinedCircles.actual,
        tier.quotas.notes.actual,
        tier.quotas.cityFilters.actual,
      ]).toEqual(actual);
      expect([
        tier.quotas.groupMembers.display,
        tier.quotas.joinedCircles.display,
        tier.quotas.notes.display,
        tier.quotas.cityFilters.display,
      ]).toEqual(display);
      expect([
        tier.appearance.nameColor,
        tier.appearance.badge,
        tier.benefits.fancyNumberVoucher,
      ]).toEqual(appearance);
    },
  );

  it('marks diamond as recommended and excludes non-membership features', () => {
    expect(MEMBERSHIP_CATALOG.map((tier) => tier.recommended)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);

    const serialized = JSON.stringify(MEMBERSHIP_CATALOG);
    expect(serialized).not.toMatch(
      /voice.?to.?text|avatar.?frame|animated.?avatar|createdCircles|premiumCircle|prioritySupport/i,
    );
  });
});

describe('resolveEffectiveMembershipLevel', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');

  it.each([NaN, Infinity, -Infinity, 1.5, -1, 0])(
    'maps invalid or regular raw level %p to regular',
    (vipLevel) => {
      expect(
        resolveEffectiveMembershipLevel({ vipLevel, vipExpiresAt: null }, now),
      ).toBe(0);
    },
  );

  it.each([1, 2, 3])(
    'keeps active and null-expiry legacy level %i effective',
    (vipLevel) => {
      expect(
        resolveEffectiveMembershipLevel(
          {
            vipLevel,
            vipExpiresAt: new Date('2026-07-21T12:00:00.001Z'),
          },
          now,
        ),
      ).toBe(vipLevel);
      expect(
        resolveEffectiveMembershipLevel({ vipLevel, vipExpiresAt: null }, now),
      ).toBe(vipLevel);
    },
  );

  it.each([1, 2, 3])(
    'treats level %i as expired at and after the exact expiry instant',
    (vipLevel) => {
      expect(
        resolveEffectiveMembershipLevel({ vipLevel, vipExpiresAt: now }, now),
      ).toBe(0);
      expect(
        resolveEffectiveMembershipLevel(
          {
            vipLevel,
            vipExpiresAt: new Date('2026-07-21T11:59:59.999Z'),
          },
          now,
        ),
      ).toBe(0);
    },
  );

  it.each([4, 5, 99])(
    'maps raw legacy level %i to lifetime super regardless of expiry',
    (vipLevel) => {
      expect(
        resolveEffectiveMembershipLevel(
          {
            vipLevel,
            vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
          },
          now,
        ),
      ).toBe(4);
    },
  );
});

describe('addUtcCalendarMonths', () => {
  it.each([
    ['2026-01-31T09:15:30.123Z', 1, '2026-02-28T09:15:30.123Z'],
    ['2024-01-31T09:15:30.123Z', 1, '2024-02-29T09:15:30.123Z'],
    ['2024-02-29T23:59:59.999Z', 12, '2025-02-28T23:59:59.999Z'],
    ['2026-08-31T00:00:00.000Z', 6, '2027-02-28T00:00:00.000Z'],
    ['2026-01-30T00:00:00.000Z', 1, '2026-02-28T00:00:00.000Z'],
  ])('adds %i UTC calendar months and clamps month-end', (from, months, to) => {
    expect(addUtcCalendarMonths(new Date(from), months).toISOString()).toBe(to);
  });

  it('does not mutate the source date', () => {
    const source = new Date('2026-01-31T09:15:30.123Z');

    addUtcCalendarMonths(source, 1);

    expect(source.toISOString()).toBe('2026-01-31T09:15:30.123Z');
  });
});
