import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PurchaseGroupExpansionDto } from './group-expansion.dto';

describe('PurchaseGroupExpansionDto', () => {
  it('accepts a UUID circle id and a catalog product id', () => {
    const dto = plainToInstance(PurchaseGroupExpansionDto, {
      circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
      productId: 'light',
    });

    expect(validateSync(dto)).toEqual([]);
  });

  it('rejects an invalid circle id and unknown product id', () => {
    const dto = plainToInstance(PurchaseGroupExpansionDto, {
      circleId: 'circle-1',
      productId: 'client-price-1',
    });

    const errors = validateSync(dto);

    expect(new Set(errors.map(({ property }) => property))).toEqual(
      new Set(['circleId', 'productId']),
    );
  });
});
