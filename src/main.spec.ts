import {
  buildNestFactoryOptions,
  createGracefulShutdownHandler,
  resolveAppPort,
} from './main';

describe('resolveAppPort', () => {
  it('rejects malformed port strings', () => {
    expect(() => resolveAppPort('3000{')).toThrow('Invalid APP_PORT value');
  });

  it('accepts numeric strings', () => {
    expect(resolveAppPort('3000')).toBe(3000);
  });
});

describe('buildNestFactoryOptions', () => {
  it('enables raw body support for signed webhooks', () => {
    expect(buildNestFactoryOptions().rawBody).toBe(true);
  });
});

describe('createGracefulShutdownHandler', () => {
  it('closes the app, then flushes error aggregation, then exits — in order', async () => {
    const calls: string[] = [];
    const app = {
      close: jest.fn(async () => {
        calls.push('close');
      }),
    };
    const errorAggregation = {
      flush: jest.fn(async () => {
        calls.push('flush');
        return true;
      }),
    };
    const onExit = jest.fn(() => calls.push('exit'));

    await createGracefulShutdownHandler(app, errorAggregation, onExit, 2000)();

    expect(calls).toEqual(['close', 'flush', 'exit']);
    expect(errorAggregation.flush).toHaveBeenCalledWith(2000);
  });

  it('still flushes and exits when app.close() throws', async () => {
    const app = { close: jest.fn().mockRejectedValue(new Error('close boom')) };
    const errorAggregation = { flush: jest.fn().mockResolvedValue(true) };
    const onExit = jest.fn();

    await createGracefulShutdownHandler(app, errorAggregation, onExit)();

    expect(errorAggregation.flush).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second signal does not close/flush/exit again', async () => {
    const app = { close: jest.fn().mockResolvedValue(undefined) };
    const errorAggregation = { flush: jest.fn().mockResolvedValue(true) };
    const onExit = jest.fn();

    const shutdown = createGracefulShutdownHandler(
      app,
      errorAggregation,
      onExit,
    );
    await shutdown();
    await shutdown();

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(errorAggregation.flush).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
