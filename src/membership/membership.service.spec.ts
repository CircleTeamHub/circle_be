import { MembershipBenefitType } from 'src/generated/prisma';
import { MembershipPolicyService } from './membership-policy.service';
import { mapMembershipStatus, MembershipService } from './membership.service';

describe('MembershipService', () => {
  const service = new MembershipService();

  it('returns the exact four paid plans from the catalog using display quotas', () => {
    expect(service.getPlans()).toEqual([
      {
        level: 1,
        name: 'Silver',
        price: 298,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
        key: 'silver',
        durationMonths: 1,
        lifetime: false,
        priceCny: 298,
        recommended: false,
        quotas: {
          groupMembers: { actual: 200, display: '200' },
          joinedCircles: { actual: 200, display: '200' },
          notes: { actual: 100, display: '100' },
          cityFilters: { actual: 2, display: '2' },
        },
        appearance: { nameColor: 'silver', badge: 'silver' },
        benefits: {
          fancyNumberVoucher: null,
          permanentFancyNumber: false,
        },
      },
      {
        level: 2,
        name: 'Gold',
        price: 1288,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
        key: 'gold',
        durationMonths: 6,
        lifetime: false,
        priceCny: 1288,
        recommended: false,
        quotas: {
          groupMembers: { actual: 400, display: '400' },
          joinedCircles: { actual: 300, display: '300' },
          notes: { actual: 500, display: '500' },
          cityFilters: { actual: 10, display: '10' },
        },
        appearance: { nameColor: 'gold', badge: 'gold' },
        benefits: {
          fancyNumberVoucher: null,
          permanentFancyNumber: false,
        },
      },
      {
        level: 3,
        name: 'Diamond',
        price: 1998,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
        key: 'diamond',
        durationMonths: 12,
        lifetime: false,
        priceCny: 1998,
        recommended: true,
        quotas: {
          groupMembers: { actual: 1000, display: '1000' },
          joinedCircles: { actual: 1000, display: '1000' },
          notes: { actual: 1000, display: '1000' },
          cityFilters: { actual: 50, display: '50' },
        },
        appearance: { nameColor: 'rainbow', badge: 'diamond' },
        benefits: {
          fancyNumberVoucher: null,
          permanentFancyNumber: false,
        },
      },
      {
        level: 4,
        name: 'Super',
        price: 3998,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
        key: 'super',
        durationMonths: null,
        lifetime: true,
        priceCny: 3998,
        recommended: false,
        quotas: {
          groupMembers: { actual: 3000, display: '3000' },
          joinedCircles: { actual: 2000, display: '2000' },
          notes: { actual: 3000, display: '3000' },
          cityFilters: { actual: 1000, display: 'unlimited' },
        },
        appearance: {
          nameColor: 'exclusive-shimmer',
          badge: 'super-lifetime',
        },
        benefits: {
          fancyNumberVoucher: null,
          permanentFancyNumber: true,
        },
      },
    ]);

    expect(MembershipService.prototype).not.toHaveProperty('upgrade');
  });

  it('satisfies the shipped v1 plan validator without restoring its five-tier fallback', () => {
    const plans = service.getPlans() as unknown as Array<{
      level: number;
      name: string;
      price: number;
      priceCny: number;
      perks: string;
    }>;

    expect(
      plans.map(({ level, name, price, perks }) => ({
        level,
        name,
        price,
        perks,
      })),
    ).toEqual([
      {
        level: 1,
        name: 'Silver',
        price: 298,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
      },
      {
        level: 2,
        name: 'Gold',
        price: 1288,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
      },
      {
        level: 3,
        name: 'Diamond',
        price: 1998,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
      },
      {
        level: 4,
        name: 'Super',
        price: 3998,
        perks:
          'See current membership benefits; contact customer service for activation or upgrade support.',
      },
    ]);
    expect(plans).toHaveLength(4);
    expect(
      plans.every(({ name, perks }) => name.length > 0 && perks.length > 0),
    ).toBe(true);
    expect(plans.every(({ price, priceCny }) => price === priceCny)).toBe(true);
    expect(plans.some(({ level }) => level === 5)).toBe(false);
  });

  // GET /membership/me 已删除;mapMembershipStatus 仍是管理员授予接口的响应映射,
  // 原 getMe 的四个档位用例改为直接钉在它上面。
  describe('mapMembershipStatus', () => {
    const policy = new MembershipPolicyService({} as never);
    const statusFor = (
      membership: { vipLevel: number; vipExpiresAt: Date | null },
      issued: MembershipBenefitType[],
      now = new Date('2026-07-21T12:00:00.000Z'),
    ) => {
      const effective = policy.resolve(membership, now);
      return mapMembershipStatus(
        membership,
        effective.tier,
        effective.level,
        issued,
      );
    };

    it('maps an active timed membership and one-time benefit status', () => {
      const expiresAt = new Date('2026-08-31T12:00:00.000Z');

      expect(
        statusFor({ vipLevel: 3, vipExpiresAt: expiresAt }, [
          MembershipBenefitType.STANDARD_FANCY_NUMBER,
        ]),
      ).toMatchObject({
        storedLevel: 3,
        effectiveLevel: 3,
        key: 'diamond',
        vipExpiresAt: expiresAt,
        lifetime: false,
        active: true,
        quotas: { joinedCircles: { actual: 1000, display: '1000' } },
        appearance: { nameColor: 'rainbow', badge: 'diamond' },
        benefits: {
          fancyNumberVoucher: null,
          permanentFancyNumber: false,
        },
        benefitGrants: {
          standardFancyNumber: { available: false, issued: true },
          premiumFancyNumber: { available: false, issued: false },
        },
      });
    });

    it('resolves an expired stored membership to regular', () => {
      const expiresAt = new Date('2026-07-20T12:00:00.000Z');

      expect(
        statusFor({ vipLevel: 2, vipExpiresAt: expiresAt }, []),
      ).toMatchObject({
        storedLevel: 2,
        effectiveLevel: 0,
        key: 'regular',
        vipExpiresAt: expiresAt,
        lifetime: false,
        active: false,
        quotas: {
          groupMembers: { actual: 100, display: '100' },
        },
      });
    });

    it('keeps legacy timed memberships with null expiry active', () => {
      expect(
        statusFor({ vipLevel: 1, vipExpiresAt: null }, [], new Date()),
      ).toMatchObject({
        storedLevel: 1,
        effectiveLevel: 1,
        key: 'silver',
        vipExpiresAt: null,
        lifetime: false,
        active: true,
      });
    });

    it('maps super as an active lifetime membership', () => {
      expect(
        statusFor(
          { vipLevel: 4, vipExpiresAt: null },
          [MembershipBenefitType.PREMIUM_FANCY_NUMBER],
          new Date(),
        ),
      ).toMatchObject({
        storedLevel: 4,
        effectiveLevel: 4,
        key: 'super',
        vipExpiresAt: null,
        lifetime: true,
        active: true,
        benefitGrants: {
          standardFancyNumber: { available: false, issued: false },
          premiumFancyNumber: { available: false, issued: true },
        },
      });
    });
  });
});
