import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AddFancyNumberRecommendationsDto,
  BatchCreateFancyNumbersDto,
  CheckCustomFancyNumberQueryDto,
  PurchaseCustomFancyNumberDto,
  PurchaseFancyNumberDto,
  ReorderFancyNumberRecommendationsDto,
  RenewFancyNumberDto,
  SwitchCustomFancyNumberDto,
  SwitchFancyNumberDto,
} from './fancy-number.dto';

describe('fancy number DTOs', () => {
  it.each([1, 12])('accepts purchase month boundary %i', async (months) => {
    const dto = plainToInstance(PurchaseFancyNumberDto, {
      months,
      expectedUnitPrice: 100,
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('allows an omitted purchase month for super-member permanent acquisition', async () => {
    const dto = plainToInstance(PurchaseFancyNumberDto, {});
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([0, 13, 1.5])('rejects invalid renewal months %p', async (months) => {
    const dto = plainToInstance(RenewFancyNumberDto, { months });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([-1, 1.5])(
    'rejects invalid expected unit price %p',
    async (price) => {
      const purchase = plainToInstance(PurchaseFancyNumberDto, {
        months: 1,
        expectedUnitPrice: price,
      });
      const renewal = plainToInstance(RenewFancyNumberDto, {
        months: 1,
        expectedUnitPrice: price,
      });
      const switchInventory = plainToInstance(SwitchFancyNumberDto, {
        expectedUnitPrice: price,
      });
      const switchCustom = plainToInstance(SwitchCustomFancyNumberDto, {
        value: 'AB12C3',
        expectedUnitPrice: price,
      });
      expect(await validate(purchase)).not.toHaveLength(0);
      expect(await validate(renewal)).not.toHaveLength(0);
      expect(await validate(switchInventory)).not.toHaveLength(0);
      expect(await validate(switchCustom)).not.toHaveLength(0);
    },
  );

  it('normalizes and validates a bounded admin inventory batch', async () => {
    const dto = plainToInstance(BatchCreateFancyNumbersDto, {
      values: ['  AbCD_1 ', '888888'],
    });

    expect(dto.values).toEqual(['abcd_1', '888888']);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('normalizes custom input to six uppercase alphanumeric characters', async () => {
    const query = plainToInstance(CheckCustomFancyNumberQueryDto, {
      value: ' ab12c3 ',
    });
    const purchase = plainToInstance(PurchaseCustomFancyNumberDto, {
      value: 'xy98z7',
      months: 2,
    });

    await expect(validate(query)).resolves.toHaveLength(0);
    await expect(validate(purchase)).resolves.toHaveLength(0);
    expect(query.value).toBe('AB12C3');
    expect(purchase.value).toBe('XY98Z7');
  });

  it('normalizes a unique six-character recommendation batch', async () => {
    const dto = plainToInstance(AddFancyNumberRecommendationsDto, {
      values: [' ab12c3 ', 'XY98z7'],
    });

    expect(dto.values).toEqual(['AB12C3', 'XY98Z7']);
    await expect(validate(dto)).resolves.toHaveLength(0);

    const duplicate = plainToInstance(AddFancyNumberRecommendationsDto, {
      values: ['AB12C3', 'ab12c3'],
    });
    expect(await validate(duplicate)).not.toHaveLength(0);
  });

  it('requires unique UUIDs in both recommendation order snapshots', async () => {
    const first = '9f14c1a3-553b-4ee2-a7bd-7388fb62d442';
    const second = 'f321786f-1c90-47cc-b87f-f9b2f5572fe8';
    const dto = plainToInstance(ReorderFancyNumberRecommendationsDto, {
      expectedIds: [first, second],
      ids: [second, first],
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    dto.ids = [first, first];
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
