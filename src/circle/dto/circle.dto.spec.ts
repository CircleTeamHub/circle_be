import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCircleDto } from './circle.dto';

describe('CreateCircleDto join VIP restriction caps at the top tier (4)', () => {
  const hasJoinVipError = (payload: Record<string, unknown>) =>
    validateSync(plainToInstance(CreateCircleDto, payload)).some(
      (e) => e.property === 'joinVipRestriction',
    );

  it('rejects a join VIP restriction above super (4)', () => {
    expect(hasJoinVipError({ joinVipRestriction: 5 })).toBe(true);
  });

  it('accepts a join VIP restriction at the top tier (4)', () => {
    expect(hasJoinVipError({ joinVipRestriction: 4 })).toBe(false);
  });
});
