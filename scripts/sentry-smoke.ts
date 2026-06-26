/**
 * Sentry smoke test — sends one real test error through the SAME provider code
 * path the app uses (config → provider → @sentry/node), reading the same .env
 * files via getServerConfig. If it succeeds, the event appears in the Sentry
 * Issues feed. Run: `npm run sentry:smoke`.
 */
import { getServerConfig } from '../src/config/server.config';
import {
  createErrorAggregationConfig,
  createErrorAggregationProvider,
} from '../src/logging/error-aggregation.service';

async function main(): Promise<void> {
  const config = getServerConfig();
  const aggConfig = createErrorAggregationConfig(
    config,
    String(config['NODE_ENV'] || process.env.NODE_ENV || 'development'),
  );

  console.log('provider:', aggConfig.provider);
  console.log('dsn present:', Boolean(aggConfig.dsn));
  console.log('environment:', aggConfig.environment);

  const provider = createErrorAggregationProvider(aggConfig);
  console.log('active provider:', provider.name);

  if (provider.name !== 'sentry') {
    console.error(
      '\n❌ Sentry is NOT active. Check LOG_AGGREGATION_PROVIDER=sentry and SENTRY_DSN in .env.development',
    );
    process.exit(1);
  }

  provider.captureError(
    new Error('Sentry smoke test from circle_be — backend wiring OK'),
    {
      statusCode: 500,
      requestId: `smoke-${Date.now()}`,
      traceId: `smoke-${Date.now()}`,
      method: 'GET',
      path: '/__smoke-test__',
      userId: 'smoke-user',
    },
  );

  const flushed = await provider.flush(5000);
  console.log(
    flushed
      ? '\n✅ Event flushed to Sentry. Open your project Issues feed — look for "Sentry smoke test from circle_be".'
      : '\n⚠️ Flush timed out (event may still arrive). Check network / DSN.',
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('smoke test failed:', error);
  process.exit(1);
});
