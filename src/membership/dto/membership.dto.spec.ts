import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpgradeMembershipDto } from './membership.dto';

describe('UpgradeMembershipDto', () => {
  it('rejects VIP5 before the upgrade service is called', () => {
    const dto = plainToInstance(UpgradeMembershipDto, { level: 5 });

    expect(validateSync(dto)[0]?.constraints).toHaveProperty('max');
  });

  it.each([1, 2, 3, 4])('accepts contract level %i', (level) => {
    expect(
      validateSync(plainToInstance(UpgradeMembershipDto, { level })),
    ).toHaveLength(0);
  });
});
