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

import {
  createRouteCardinalityLimiter,
  normalizeRoute,
} from '../metrics/route-normalizer';

export type ErrorAggregationProviderName = 'none' | 'sentry';

export interface ErrorAggregationConfig {
  provider: ErrorAggregationProviderName;
  dsn?: string;
  environment: string;
  release?: string;
}

/** Sanitized, non-sensitive request metadata attached to a captured error. */
export interface ErrorAggregationContext {
  /** Present only for HTTP failures; operational events deliberately omit it. */
  statusCode?: number;
  requestId?: string;
  traceId?: string;
  method?: string;
  path?: string;
  userId?: string;
  component?: string;
  operation?: string;
  kind?: string;
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
const SENSITIVE_URL_PATTERN = /https?:\/\/[^\s"'<>)]*\?[^\s"'<>)]*/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SENSITIVE_EVENT_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'email',
  'phone',
  'phonenumber',
]);

function sanitizeString(value: string): string {
  return value
    .replace(SENSITIVE_URL_PATTERN, '[REDACTED_URL]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_TOKEN]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}

function stableTagSegment(value: string | undefined): string | undefined {
  return value && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function safeErrorMessage(context: ErrorAggregationContext): string {
  const component = stableTagSegment(context.component);
  const operation = stableTagSegment(context.operation);
  return component && operation
    ? `${component}.${operation} failure`
    : 'http server error';
}

function toSafeError(error: unknown, context: ErrorAggregationContext): Error {
  const message = safeErrorMessage(context);
  if (error && typeof error === 'object' && 'message' in error) {
    const errorLike = error as {
      message?: unknown;
      name?: unknown;
      stack?: unknown;
    };
    const safe = new Error(message);
    const candidateName =
      typeof errorLike.name === 'string' ? errorLike.name : 'Error';
    safe.name = stableTagSegment(candidateName) ?? 'Error';
    if (typeof errorLike.stack === 'string') {
      const lines = sanitizeString(errorLike.stack).split('\n');
      safe.stack = [`${safe.name}: ${message}`, ...lines.slice(1)].join('\n');
    }
    return safe;
  }
  return new Error(message);
}

function sanitizeEventValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[MAX_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEventValue(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_EVENT_KEYS.has(key.toLowerCase())
      ? '[REDACTED]'
      : sanitizeEventValue(child, depth + 1);
  }
  return output;
}

function sanitizeEventStacktrace(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const frames = (value as Record<string, unknown>).frames;
  if (!Array.isArray(frames)) return undefined;
  return {
    frames: frames.map((frame) => {
      if (!frame || typeof frame !== 'object') return {};
      const source = frame as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const key of [
        'filename',
        'function',
        'module',
        'lineno',
        'colno',
        'in_app',
        'instruction_addr',
        'addr_mode',
        'image_addr',
        'package',
      ]) {
        if (key in source) safe[key] = sanitizeEventValue(source[key], 0);
      }
      return safe;
    }),
  };
}

function sanitizeEventException(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const values = (value as Record<string, unknown>).values;
  if (!Array.isArray(values)) return undefined;
  return {
    values: values.map((entry) => {
      if (!entry || typeof entry !== 'object') return {};
      const source = entry as Record<string, unknown>;
      const safe: Record<string, unknown> = {
        value: '[REDACTED_EXCEPTION]',
      };
      if (typeof source.type === 'string') {
        safe.type = stableTagSegment(source.type) ?? 'Error';
      }
      const stacktrace = sanitizeEventStacktrace(source.stacktrace);
      if (stacktrace) safe.stacktrace = stacktrace;
      return safe;
    }),
  };
}

function sanitizeAutomaticEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event;
  const source = event as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of [
    'event_id',
    'timestamp',
    'platform',
    'level',
    'logger',
    'release',
    'dist',
    'environment',
    'server_name',
    'type',
  ]) {
    if (key in source) safe[key] = sanitizeEventValue(source[key], 0);
  }
  if ('message' in source) safe.message = '[REDACTED_EVENT_MESSAGE]';
  const exception = sanitizeEventException(source.exception);
  if (exception) safe.exception = exception;
  const stacktrace = sanitizeEventStacktrace(source.stacktrace);
  if (stacktrace) safe.stacktrace = stacktrace;
  if (source.tags && typeof source.tags === 'object') {
    const sourceTags = source.tags as Record<string, unknown>;
    const safeTags: Record<string, unknown> = {};
    for (const key of [
      'statusCode',
      'requestId',
      'traceId',
      'method',
      'path',
      'component',
      'operation',
      'kind',
    ]) {
      if (key in sourceTags)
        safeTags[key] = sanitizeEventValue(sourceTags[key], 0);
    }
    if (Object.keys(safeTags).length > 0) safe.tags = safeTags;
  }
  for (const key of ['debug_meta', 'modules', 'sdk']) {
    if (key in source) safe[key] = sanitizeEventValue(source[key], 0);
  }
  return safe;
}

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

  /**
   * Own limiter instance rather than the app-wide `limitRouteCardinality`: that
   * one is fed by the HTTP middleware on every request, so 404 scanning spends
   * its unknown-route budget long before any 5xx happens — sharing it would
   * bucket the first genuine drifted-route error into `/__other__` and lose the
   * path exactly when Sentry needs it. Sentry tags and Prometheus labels also
   * price cardinality differently (indexed retention vs series memory), so the
   * budgets are better kept independent.
   */
  constructor(
    private readonly client: SentryClientLike,
    private readonly limitPathCardinality: (
      route: string,
    ) => string = createRouteCardinalityLimiter(),
  ) {}

  captureError(error: unknown, context: ErrorAggregationContext): void {
    if (
      context.statusCode !== undefined &&
      context.statusCode < SERVER_ERROR_THRESHOLD
    ) {
      return;
    }

    const captureContext: {
      tags: Record<string, string>;
    } = {
      tags: buildTags(context, this.limitPathCardinality),
    };

    this.client.captureException(toSafeError(error, context), captureContext);
  }

  flush(timeoutMs?: number): Promise<boolean> {
    return this.client.flush(timeoutMs);
  }
}

function buildTags(
  context: ErrorAggregationContext,
  limitPathCardinality: (route: string) => string,
): Record<string, string> {
  const tags: Record<string, string> = {};
  if (context.statusCode !== undefined) {
    tags.statusCode = String(context.statusCode);
  }
  if (context.requestId) tags.requestId = context.requestId;
  if (context.traceId) tags.traceId = context.traceId;
  if (context.method) tags.method = context.method;
  if (context.component) tags.component = sanitizeString(context.component);
  if (context.operation) tags.operation = sanitizeString(context.operation);
  if (context.kind) tags.kind = sanitizeString(context.kind);
  // Normalize before tagging: the raw path carries id/link-token segments
  // (e.g. /temp-chat/by-token/<token>/join) — sending those to Sentry would
  // leak secrets into an indexed, retained tag. Normalizing alone is not enough:
  // a path with no matching template is returned verbatim, so route drift or a
  // 5xx storm on unlisted paths would still mint unbounded tag values. Cap them.
  if (context.path) {
    tags.path = limitPathCardinality(normalizeRoute(context.path));
  }
  return tags;
}

let activeErrorAggregationProvider: ErrorAggregationProvider =
  new NoopErrorAggregationProvider();
const OPERATIONAL_ERROR_DEDUP_MS = 60_000;
const MAX_OPERATIONAL_ERROR_SIGNATURES = 200;
const operationalErrorLastReportedAt = new Map<string, number>();

/** Installs the provider created during bootstrap for non-HTTP failure paths. */
export function configureErrorAggregationProvider(
  provider: ErrorAggregationProvider,
): void {
  activeErrorAggregationProvider = provider;
  operationalErrorLastReportedAt.clear();
}

/**
 * Reports a caught WebSocket/background failure through the same sanitized
 * provider as HTTP 5xx errors. Callers supply only stable, content-free tags.
 */
export function reportOperationalError(
  error: unknown,
  context: Pick<ErrorAggregationContext, 'component' | 'operation' | 'kind'>,
): void {
  try {
    const rawSignature = [
      context.component ?? 'unknown-component',
      context.operation ?? 'unknown-operation',
      context.kind ?? 'unknown-kind',
    ].join(':');
    const signature =
      operationalErrorLastReportedAt.has(rawSignature) ||
      operationalErrorLastReportedAt.size < MAX_OPERATIONAL_ERROR_SIGNATURES
        ? rawSignature
        : '__other__';
    const now = Date.now();
    const lastReportedAt = operationalErrorLastReportedAt.get(signature) ?? 0;
    if (now - lastReportedAt < OPERATIONAL_ERROR_DEDUP_MS) return;
    operationalErrorLastReportedAt.set(signature, now);
    const aggregationContext: ErrorAggregationContext = { ...context };
    activeErrorAggregationProvider.captureError(
      toSafeError(error, aggregationContext),
      aggregationContext,
    );
  } catch {
    // Observability must never change the operational failure path.
  }
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sentry = require('@sentry/node') as {
    init: (options: Record<string, unknown>) => void;
    captureException: SentryClientLike['captureException'];
    flush: SentryClientLike['flush'];
  };

  Sentry.init(createSentryInitOptions(config));

  return {
    captureException: (error, captureContext) =>
      Sentry.captureException(error, captureContext),
    flush: (timeoutMs) => Sentry.flush(timeoutMs),
  };
}

export function createSentryInitOptions(
  config: ErrorAggregationConfig,
): Record<string, unknown> {
  return {
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    sendDefaultPii: false,
    // Keep the SDK's process-level crash integrations. beforeSend rebuilds every
    // event from an allowlist, so global events cannot include request data,
    // local variables, breadcrumbs, extras, or account identifiers.
    beforeSend: sanitizeAutomaticEvent,
    // Error aggregation only — no performance tracing by default.
    tracesSampleRate: 0,
  };
}
