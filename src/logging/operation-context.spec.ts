import {
  getOperationContext,
  runWithOperationContext,
} from './operation-context';

describe('operation context', () => {
  it('keeps concurrent run IDs isolated across awaited work', async () => {
    const observed = await Promise.all(
      ['first', 'second'].map((runId) =>
        runWithOperationContext({ job: 'sweeper', runId }, async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return getOperationContext();
        }),
      ),
    );
    expect(observed).toEqual([
      { job: 'sweeper', runId: 'first' },
      { job: 'sweeper', runId: 'second' },
    ]);
    expect(getOperationContext()).toBeUndefined();
  });

  it('restores the parent context after a nested run throws', async () => {
    await runWithOperationContext(
      { job: 'outer', runId: 'outer-run' },
      async () => {
        const original = new Error('original');
        await expect(
          runWithOperationContext(
            { job: 'inner', runId: 'inner-run' },
            async () => {
              await Promise.resolve();
              throw original;
            },
          ),
        ).rejects.toBe(original);
        expect(getOperationContext()).toEqual({
          job: 'outer',
          runId: 'outer-run',
        });
      },
    );
    expect(getOperationContext()).toBeUndefined();
  });
});
