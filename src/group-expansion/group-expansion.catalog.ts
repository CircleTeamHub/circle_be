export const GROUP_EXPANSION_PRODUCTS = [
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
] as const;

export type GroupExpansionProductId =
  (typeof GROUP_EXPANSION_PRODUCTS)[number]['id'];
export type GroupExpansionProduct = (typeof GROUP_EXPANSION_PRODUCTS)[number];

export function getGroupExpansionProduct(
  productId: string,
): GroupExpansionProduct | undefined {
  return GROUP_EXPANSION_PRODUCTS.find(({ id }) => id === productId);
}
