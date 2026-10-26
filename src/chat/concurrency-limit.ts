type TaskResults<T extends readonly (() => Promise<unknown>)[]> = {
  -readonly [K in keyof T]: Awaited<ReturnType<T[K]>>;
};

/**
 * 和 Promise.all 一样按下标返回结果、任一失败即拒绝,但同时最多只跑 limit 个任务,
 * 按给定顺序开跑。用来限住一次请求同时占用的数据库连接数(池默认只有 10 个):
 * 一个请求把 7 条查询同时发出去,两个并发请求就能把池占满。
 *
 * 失败后不再开新任务;已经在跑的照常结束,结果丢弃。
 */
export function allWithConcurrency<
  const T extends readonly (() => Promise<unknown>)[],
>(limit: number, tasks: T): Promise<TaskResults<T>> {
  const results = new Array<unknown>(tasks.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), tasks.length) },
    () => worker(),
  );
  return Promise.all(workers).then(() => results as TaskResults<T>);
}
