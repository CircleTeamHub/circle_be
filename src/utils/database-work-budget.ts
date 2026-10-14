/** Reserve enough pool capacity for the nested queries performed by auth workflows. */
export class DatabaseWorkBudget {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly poolMax: () => number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.poolMax() < 2)
      throw new Error(
        'Authentication requires at least two database connections',
      );
    const limit = Math.max(1, Math.floor(this.poolMax() / 3));
    if (this.active < limit) this.active++;
    else {
      if (this.waiting.length >= 100) throw new Error('Authentication is busy');
      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(enter);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(new Error('Authentication queue timed out'));
          }
        }, 10000);
        this.waiting.push(enter);
      });
    }
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const budgets = new WeakMap<object, DatabaseWorkBudget>();
export function withDatabaseWorkBudget<T>(
  client: object & { getPoolStats?: () => { max: number } | null },
  operation: () => Promise<T>,
): Promise<T> {
  let budget = budgets.get(client);
  if (!budget) {
    budget = new DatabaseWorkBudget(() => client.getPoolStats?.()?.max ?? 10);
    budgets.set(client, budget);
  }
  return budget.run(operation);
}
