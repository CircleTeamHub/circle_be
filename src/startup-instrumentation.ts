import 'source-map-support/register';
import { getServerConfig } from './config/server.config';
import {
  configureErrorAggregationProvider,
  createErrorAggregationConfig,
  createErrorAggregationProvider,
  type ErrorAggregationProvider,
} from './logging/error-aggregation.service';
import { installUnhandledRejectionGuard } from './logging/unhandled-rejection-guard';

const fileConfig = getServerConfig();
const resolvedConfig = { ...fileConfig, ...process.env };
const startupErrorAggregation = createErrorAggregationProvider(
  createErrorAggregationConfig(
    resolvedConfig,
    String(process.env.NODE_ENV || fileConfig['NODE_ENV'] || 'development'),
  ),
);
configureErrorAggregationProvider(startupErrorAggregation);
installUnhandledRejectionGuard();

export function getStartupErrorAggregation(): ErrorAggregationProvider {
  return startupErrorAggregation;
}
