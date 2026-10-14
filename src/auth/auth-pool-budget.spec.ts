import { DatabaseWorkBudget } from '../utils/database-work-budget';

test('ten concurrent auth workflows leave connection capacity for nested work', async () => {
  const budget = new DatabaseWorkBudget(() => 10);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 10 }, () =>
    budget.run(async () => {
      active++;
      peak = Math.max(peak, active);
      await barrier;
      active--;
      return true;
    }),
  );
  await Promise.resolve();
  expect(active).toBe(3);
  release();
  expect(await Promise.all(requests)).toEqual(Array(10).fill(true));
  expect(peak).toBe(3);
});
