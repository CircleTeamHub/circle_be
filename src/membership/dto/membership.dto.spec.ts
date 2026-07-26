import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpgradeMembershipDto } from './membership.dto';

describe('UpgradeMembershipDto', () => {
  it('accepts the top supported tier (4 = super)', () => {
    const dto = plainToInstance(UpgradeMembershipDto, { level: 4 });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects the retired VIP5 level at the contract boundary', () => {
    const dto = plainToInstance(UpgradeMembershipDto, { level: 5 });
    const errors = validateSync(dto);
    expect(errors.some((e) => e.property === 'level')).toBe(true);
  });
});
