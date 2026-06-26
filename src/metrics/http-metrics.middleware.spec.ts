import { EventEmitter } from 'events';
import { createHttpMetricsMiddleware } from './http-metrics.middleware';
import type { Metrics } from './metrics.service';

function createMetricsSpy() {
  return {
    registry: {} as Metrics['registry'],
    recordHttpRequest: jest.fn(),
  };
}

function fakeReq(method: string, path: string) {
  return { method, path } as never;
}

function fakeRes(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res as never;
}

describe('createHttpMetricsMiddleware', () => {
  it('records a request with normalized route only after the response finishes', () => {
    const metrics = createMetricsSpy();
    const middleware = createHttpMetricsMiddleware(metrics);
    const req = fakeReq(
      'GET',
      '/api/v1/circle/3fa85f64-5717-4562-b3fc-2c963f66afa6',
    );
    const res = fakeRes(200);
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(metrics.recordHttpRequest).not.toHaveBeenCalled();

    (res as unknown as EventEmitter).emit('finish');

    expect(metrics.recordHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        route: '/api/v1/circle/:id',
        statusCode: 200,
      }),
    );
    const [sample] = metrics.recordHttpRequest.mock.calls[0];
    expect(typeof sample.durationSeconds).toBe('number');
    expect(sample.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does not record the /metrics scrape endpoint itself', () => {
    const metrics = createMetricsSpy();
    const middleware = createHttpMetricsMiddleware(metrics);
    const res = fakeRes(200);
    const next = jest.fn();

    middleware(fakeReq('GET', '/metrics'), res, next);
    expect(next).toHaveBeenCalledTimes(1);

    (res as unknown as EventEmitter).emit('finish');
    expect(metrics.recordHttpRequest).not.toHaveBeenCalled();
  });
});
