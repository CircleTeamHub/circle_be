import { of, Subject, throwError } from 'rxjs';
import { HttpCapacityInterceptor } from './http-capacity.interceptor';
import { gatewayMetrics } from '../metrics/gateway-metrics';

it('rejects excess work and recovers capacity after completion and failure', async () => {
  gatewayMetrics.registry.resetMetrics();
  const interceptor = new HttpCapacityInterceptor();
  const header = jest.fn();
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => ({ setHeader: header }) }),
  };
  const held = new Subject();
  const subscriptions = Array.from({ length: 128 }, () =>
    interceptor.intercept(context as never, { handle: () => held }).subscribe(),
  );
  const handle = jest.fn(() => of('ok'));
  const error = jest.fn();
  interceptor.intercept(context as never, { handle }).subscribe({ error });
  expect(handle).not.toHaveBeenCalled();
  expect(error.mock.calls[0][0].getStatus()).toBe(503);
  expect(header).toHaveBeenCalledWith('Retry-After', '1');
  let metrics = await gatewayMetrics.registry.metrics();
  expect(metrics).toContain('circle_gateway_capacity_used{pool="http"} 128');
  expect(metrics).toContain('circle_gateway_capacity_limit{pool="http"} 128');
  expect(metrics).toContain(
    'circle_gateway_rejections_total{pool="http",reason="capacity"} 1',
  );
  held.complete();
  const failure = new Error('handler failed');
  interceptor
    .intercept(context as never, { handle: () => throwError(() => failure) })
    .subscribe({ error });
  const next = jest.fn();
  interceptor.intercept(context as never, { handle }).subscribe(next);
  expect(next).toHaveBeenCalledWith('ok');
  // Synchronous exceptions and cancelled subscriptions also free the slot.
  interceptor
    .intercept(context as never, {
      handle: () => {
        throw failure;
      },
    })
    .subscribe({ error });
  const cancelled = interceptor
    .intercept(context as never, { handle: () => new Subject() })
    .subscribe();
  cancelled.unsubscribe();
  metrics = await gatewayMetrics.registry.metrics();
  expect(metrics).toContain('circle_gateway_capacity_used{pool="http"} 0');
  for (const subscription of subscriptions) subscription.unsubscribe();
});
