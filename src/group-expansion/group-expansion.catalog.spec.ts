import {
  GROUP_EXPANSION_PRODUCTS,
  getGroupExpansionProduct,
} from './group-expansion.catalog';

describe('group expansion catalog', () => {
  it('offers four permanent seat bundles aligned to membership capacity gaps', () => {
    expect(GROUP_EXPANSION_PRODUCTS).toEqual([
      {
        id: 'light',
        name: '轻量扩群卡',
        seats: 100,
        price: 100,
      },
      {
        id: 'advanced',
        name: '进阶扩群卡',
        seats: 200,
        price: 180,
      },
      {
        id: 'large',
        name: '大型扩群卡',
        seats: 600,
        price: 480,
      },
      {
        id: 'flagship',
        name: '旗舰扩群卡',
        seats: 2000,
        price: 1000,
      },
    ]);
  });

  it('returns undefined for a client-supplied product id outside the catalog', () => {
    expect(getGroupExpansionProduct('client-price-1')).toBeUndefined();
  });
});
