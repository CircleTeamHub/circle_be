import { resolveEffectiveFancyNumber } from './fancy-number-status';

describe('resolveEffectiveFancyNumber', () => {
  const now = new Date('2026-07-28T00:00:00.000Z');

  it('accepts permanent and unexpired fancy numbers', () => {
    expect(
      resolveEffectiveFancyNumber(
        {
          fancyNumber: true,
          fancyNumberPermanent: true,
          fancyNumberExpiresAt: null,
        },
        now,
      ),
    ).toBe(true);
    expect(
      resolveEffectiveFancyNumber(
        {
          fancyNumber: true,
          fancyNumberPermanent: false,
          fancyNumberExpiresAt: new Date('2026-07-29T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe(true);
  });

  it('rejects a paid fancy number at and after its expiry boundary', () => {
    expect(
      resolveEffectiveFancyNumber(
        {
          fancyNumber: true,
          fancyNumberPermanent: false,
          fancyNumberExpiresAt: now,
        },
        now,
      ),
    ).toBe(false);
  });

  it('keeps legacy fancy-number rows effective until migration backfill', () => {
    expect(
      resolveEffectiveFancyNumber(
        {
          fancyNumber: true,
          fancyNumberPermanent: false,
          fancyNumberExpiresAt: null,
        },
        now,
      ),
    ).toBe(true);
  });
});
