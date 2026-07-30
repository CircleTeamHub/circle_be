import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PurchaseGroupExpansionDto } from './group-expansion.dto';

describe('PurchaseGroupExpansionDto', () => {
  it('keeps legacy clients valid when no quote fields are sent', () => {
    const dto = plainToInstance(PurchaseGroupExpansionDto, {
      circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
      productId: 'light',
    });

    expect(validateSync(dto)).toEqual([]);
  });

  it('accepts a UUID circle id and a catalog product id', () => {
    const dto = plainToInstance(PurchaseGroupExpansionDto, {
      circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
      productId: 'light',
      expectedPrice: 100,
      expectedSeats: 100,
    });

    expect(validateSync(dto)).toEqual([]);
  });

  it('requires a complete positive quote when either quote field is sent', () => {
    const missingSeats = plainToInstance(PurchaseGroupExpansionDto, {
      circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
      productId: 'light',
      expectedPrice: 100,
    });
    const invalidPrice = plainToInstance(PurchaseGroupExpansionDto, {
      circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
      productId: 'light',
      expectedPrice: 0,
      expectedSeats: 100,
    });

    expect(
      validateSync(missingSeats).map(({ property }) => property),
    ).toContain('expectedSeats');
    expect(
      validateSync(invalidPrice).map(({ property }) => property),
    ).toContain('expectedPrice');
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
