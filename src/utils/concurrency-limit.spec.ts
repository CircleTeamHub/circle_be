import { createConcurrencyLimiter, runUnlimited } from './concurrency-limit';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createConcurrencyLimiter', () => {
  it('never runs more than the limit at once and starts queued tasks in FIFO order', async () => {
    const limit = createConcurrencyLimiter(2);
    const gates = [0, 1, 2, 3, 4].map(() => deferred<number>());
    const started: number[] = [];
    const results = gates.map((gate, index) =>
      limit(() => {
        started.push(index);
        return gate.promise;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);
    gates[1].resolve(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve(0);
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve(2);
    gates[3].resolve(3);
    gates[4].resolve(4);

    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2, 3, 4]);
  });

  it('hands a rejection to its own caller and frees the slot', async () => {
    const limit = createConcurrencyLimiter(1);
    const failing = limit(() => Promise.reject(new Error('boom')));
    const next = limit(() => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('treats a synchronous throw as a rejection instead of leaking the slot', async () => {
    const limit = createConcurrencyLimiter(1);
    const failing = limit(() => {
      throw new Error('sync');
    });
    const next = limit(() => Promise.resolve('after'));

    await expect(failing).rejects.toThrow('sync');
    await expect(next).resolves.toBe('after');
  });

  it('starts a lazy thenable (PrismaPromise) only when its slot opens', async () => {
    const limit = createConcurrencyLimiter(1);
    const gate = deferred<void>();
    let executed = false;
    const lazy = {
      then(resolve: (value: string) => void) {
        executed = true;
        resolve('lazy');
      },
    } as unknown as Promise<string>;

    const first = limit(() => gate.promise);
    const second = limit(() => lazy);
    await flush();
    expect(executed).toBe(false);
    gate.resolve();
    await first;
    await expect(second).resolves.toBe('lazy');
    expect(executed).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
    expect(() => createConcurrencyLimiter(1.5)).toThrow();
  });
});

describe('runUnlimited', () => {
  it('runs immediately without queuing', async () => {
    await expect(runUnlimited(() => Promise.resolve(7))).resolves.toBe(7);
  });
});
