import { createMetricsHandler } from './metrics.endpoint';
import type { Metrics } from './metrics.service';

function fakeMetrics(overrides: Partial<Metrics['registry']>): Metrics {
  return {
    registry: {
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      ...overrides,
    } as Metrics['registry'],
    recordHttpRequest: jest.fn(),
  };
}

describe('createMetricsHandler', () => {
  it('writes the registry output with the prometheus content type', async () => {
    const metrics = fakeMetrics({
      metrics: jest.fn().mockResolvedValue('# HELP up\nup 1\n'),
    } as Partial<Metrics['registry']>);
    const setHeader = jest.fn();
    const end = jest.fn();

    await createMetricsHandler(metrics.registry)(
      {} as never,
      {
        setHeader,
        end,
      } as never,
    );

    expect(setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(end).toHaveBeenCalledWith('# HELP up\nup 1\n');
  });

  it('responds 500 when metric collection fails', async () => {
    const metrics = fakeMetrics({
      metrics: jest.fn().mockRejectedValue(new Error('boom')),
    } as Partial<Metrics['registry']>);
    const status = jest.fn().mockReturnThis();
    const end = jest.fn();

    await createMetricsHandler(metrics.registry)(
      {} as never,
      {
        setHeader: jest.fn(),
        status,
        end,
      } as never,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(end).toHaveBeenCalled();
  });

  describe('when an auth token is configured', () => {
    const collect = jest.fn().mockResolvedValue('# HELP up\nup 1\n');
    const buildMetrics = () =>
      fakeMetrics({ metrics: collect } as Partial<Metrics['registry']>);

    const invoke = (authorization?: string) => {
      const status = jest.fn().mockReturnThis();
      const end = jest.fn();
      const setHeader = jest.fn();
      const handler = createMetricsHandler(buildMetrics().registry, {
        authToken: 'super-secret',
      });
      return {
        result: handler(
          { headers: { authorization } } as never,
          { status, setHeader, end } as never,
        ),
        status,
        end,
        setHeader,
      };
    };

    beforeEach(() => collect.mockClear());

    it('rejects a request with no Authorization header', async () => {
      const { result, status, setHeader } = invoke();
      await result;
      expect(status).toHaveBeenCalledWith(401);
      expect(setHeader).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
    });

    it('rejects a wrong bearer token without leaking metrics', async () => {
      const { result, status } = invoke('Bearer nope');
      await result;
      expect(status).toHaveBeenCalledWith(401);
      expect(collect).not.toHaveBeenCalled();
    });

    it('rejects a non-bearer scheme', async () => {
      const { result, status } = invoke('Basic super-secret');
      await result;
      expect(status).toHaveBeenCalledWith(401);
    });

    it('serves metrics when the bearer token matches', async () => {
      const { result, setHeader, end } = invoke('Bearer super-secret');
      await result;
      expect(setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/plain; version=0.0.4; charset=utf-8',
      );
      expect(end).toHaveBeenCalledWith('# HELP up\nup 1\n');
    });
  });
});
