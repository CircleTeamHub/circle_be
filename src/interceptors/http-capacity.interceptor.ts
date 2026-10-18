import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { defer, finalize } from 'rxjs';
import { gatewayMetrics } from '../metrics/gateway-metrics';

/** Per-process controller work budget; retain a slot until the handler settles. */
@Injectable()
export class HttpCapacityInterceptor implements NestInterceptor {
  private active = 0;
  private readonly limit = 128;

  constructor() {
    gatewayMetrics.setBudget('http', 0, this.limit);
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    return defer(() => {
      if (this.active >= this.limit) {
        gatewayMetrics.reject('http', 'capacity');
        context.switchToHttp().getResponse().setHeader('Retry-After', '1');
        throw new ServiceUnavailableException(
          'Server is busy, please try again later',
        );
      }
      this.active += 1;
      gatewayMetrics.setBudget('http', this.active, this.limit);
      return defer(() => next.handle()).pipe(
        finalize(() => {
          this.active -= 1;
          gatewayMetrics.setBudget('http', this.active, this.limit);
        }),
      );
    });
  }
}
