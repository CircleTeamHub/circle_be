import { buildLeveledSystemIcons } from './icon-badges';

describe('membership system badges', () => {
  it.each([
    [1, 'VIP1', '白银会员'],
    [2, 'VIP2', '黄金会员'],
    [3, 'VIP3', '钻石会员'],
    [4, 'VIP4', '超级会员'],
    [5, 'VIP4', '超级会员'],
  ])(
    'emits only the effective membership badge for stored level %i',
    (vipLevel, systemVariant, title) => {
      const icons = buildLeveledSystemIcons({
        vipLevel,
        vipExpiresAt: null,
        receivedLikeCount: 0,
      } as Parameters<typeof buildLeveledSystemIcons>[0]);

      expect(icons.filter((icon) => icon.systemKey === 'VIP')).toEqual([
        expect.objectContaining({ systemVariant, title }),
      ]);
    },
  );

  it('does not emit a membership badge at the exact expiry boundary', () => {
    const now = new Date('2026-07-22T12:00:00.000Z');

    expect(
      buildLeveledSystemIcons(
        {
          vipLevel: 3,
          vipExpiresAt: now,
          receivedLikeCount: 0,
        } as Parameters<typeof buildLeveledSystemIcons>[0],
        now,
      ).some((icon) => icon.systemKey === 'VIP'),
    ).toBe(false);
  });
});
