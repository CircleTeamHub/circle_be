/**
 * Optional error aggregation (e.g. Sentry) for unhandled server errors.
 *
 * Provider-neutral by design: the rest of the app talks to the
 * {@link ErrorAggregationProvider} interface, so Datadog/Loki/CloudWatch can be
 * added later without touching call sites. Disabled unless explicitly
 * configured — only `LOG_AGGREGATION_PROVIDER=sentry` together with a
 * `SENTRY_DSN` activates real reporting; everything else is a no-op.
 *
 * Only unexpected 5xx errors are forwarded. Expected 4xx validation/auth
 * failures are never sent, and only sanitized request tags (no bodies, headers,
 * or tokens) accompany the captured exception.
 */

export type ErrorAggregationProviderName = 'none' | 'sentry';

export interface ErrorAggregationConfig {
  provider: ErrorAggregationProviderName;
  dsn?: string;
  environment: string;
  release?: string;
}

/** Sanitized, non-sensitive request metadata attached to a captured error. */
export interface ErrorAggregationContext {
  statusCode: number;
  requestId?: string;
  traceId?: string;
  method?: string;
  path?: string;
  userId?: string;
}

export interface ErrorAggregationProvider {
  readonly name: ErrorAggregationProviderName;
  captureError(error: unknown, context: ErrorAggregationContext): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * Minimal slice of the Sentry SDK we depend on. Declaring it locally lets tests
 * inject a fake and keeps the no-op path from ever loading `@sentry/node`.
 */
export interface SentryClientLike {
  captureException(
    error: unknown,
    captureContext?: {
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
      user?: { id?: string };
    },
  ): string;
  flush(timeoutMs?: number): Promise<boolean>;
}

export type SentryClientFactory = (
  config: ErrorAggregationConfig,
) => SentryClientLike | undefined;

/** Status codes below this are expected client errors and never reported. */
const SERVER_ERROR_THRESHOLD = 500;

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function createErrorAggregationConfig(
  rawConfig: Record<string, unknown> = process.env,
  nodeEnv = process.env.NODE_ENV || 'development',
): ErrorAggregationConfig {
  const requested = readString(
    rawConfig['LOG_AGGREGATION_PROVIDER'],
  )?.toLowerCase();
  const provider: ErrorAggregationProviderName =
    requested === 'sentry' ? 'sentry' : 'none';

  return {
    provider,
    dsn: readString(rawConfig['SENTRY_DSN']),
    environment: readString(rawConfig['SENTRY_ENVIRONMENT']) ?? nodeEnv,
    release: readString(rawConfig['SENTRY_RELEASE']),
  };
}

export class NoopErrorAggregationProvider implements ErrorAggregationProvider {
  readonly name = 'none';

  captureError(_error: unknown, _context: ErrorAggregationContext): void {
    // Intentionally does nothing — aggregation is disabled.
  }

  flush(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export class SentryErrorAggregationProvider implements ErrorAggregationProvider {
  readonly name = 'sentry';

  constructor(private readonly client: SentryClientLike) {}

  captureError(error: unknown, context: ErrorAggregationContext): void {
    if (context.statusCode < SERVER_ERROR_THRESHOLD) {
      return;
    }

    const captureContext: {
      tags: Record<string, string>;
      user?: { id: string };
    } = {
      tags: buildTags(context),
    };

    if (context.userId) {
      captureContext.user = { id: context.userId };
    }

    this.client.captureException(error, captureContext);
  }

  flush(timeoutMs?: number): Promise<boolean> {
    return this.client.flush(timeoutMs);
  }
}

function buildTags(context: ErrorAggregationContext): Record<string, string> {
  const tags: Record<string, string> = {
    statusCode: String(context.statusCode),
  };
  if (context.requestId) tags.requestId = context.requestId;
  if (context.traceId) tags.traceId = context.traceId;
  if (context.method) tags.method = context.method;
  if (context.path) tags.path = context.path;
  return tags;
}

/**
 * Builds the aggregation provider from resolved config. Returns a no-op unless
 * the sentry provider is selected, a dsn is present, and a client is created —
 * so misconfiguration degrades to silence rather than a boot crash.
 */
export function createErrorAggregationProvider(
  config: ErrorAggregationConfig,
  clientFactory: SentryClientFactory = defaultSentryClientFactory,
): ErrorAggregationProvider {
  if (config.provider !== 'sentry' || !config.dsn) {
    return new NoopErrorAggregationProvider();
  }

  const client = clientFactory(config);
  if (!client) {
    return new NoopErrorAggregationProvider();
  }

  return new SentryErrorAggregationProvider(client);
}

function defaultSentryClientFactory(
  config: ErrorAggregationConfig,
): SentryClientLike | undefined {
  // Lazily loaded so the no-op path never pulls in the SDK. Only reached when
  // sentry is enabled and a dsn is configured.
  const Sentry = require('@sentry/node') as {
    init: (options: Record<string, unknown>) => void;
    captureException: SentryClientLike['captureException'];
    flush: SentryClientLike['flush'];
  };

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    // Error aggregation only — no performance tracing by default.
    tracesSampleRate: 0,
  });

  return {
    captureException: (error, captureContext) =>
      Sentry.captureException(error, captureContext),
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  };
}
