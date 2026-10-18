// Copyright (c) 2022 toimc<admin@wayearn.com>
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT
import { getStartupErrorAggregation } from './startup-instrumentation';
import { flushWithDeadline } from './logging/error-aggregation.service';
import 'module-alias/register';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupApp } from './setup';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { ChatGateway } from './chat/chat.gateway';
// import { AllExceptionFilter } from './filters/all-exception.filter';
import { getServerConfig } from './config/server.config';
import { sanitizeLogValue } from './logging/log-sanitizer';

export function resolveAppPort(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= 0 && value <= 65535) {
      return value;
    }
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const port = Number.parseInt(value, 10);
    if (port >= 0 && port <= 65535) {
      return port;
    }
  }

  throw Object.assign(new Error(`Invalid APP_PORT value: ${String(value)}`), {
    startupCode: 'INVALID_APP_PORT',
  });
}

import { resolveCorsOriginChecker } from './config/cors-origin';
export { resolveCorsOriginChecker } from './config/cors-origin';

export function buildNestFactoryOptions() {
  return {
    cors: {
      origin: resolveCorsOriginChecker(),
      credentials: true,
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-Request-Id',
        'X-Device-Name',
        // 陌生设备登录验证的设备标识；网页端不放行就永远被当成陌生设备。
        'X-Device-Id',
        'Idempotency-Key',
      ],
      // GET /note and /note/recycle-bin signal truncation through this header
      // while the body stays an array; browsers hide unlisted response headers
      // from cross-origin callers.
      exposedHeaders: ['X-Has-More', 'X-Request-Id'],
    },
    rawBody: true,
  };
}

/** The slice of the Nest app the shutdown handler needs — keeps it unit-testable. */
export interface ClosableApp {
  close(): Promise<void>;
}

/** The slice of the error-aggregation provider the shutdown handler needs. */
export interface FlushableAggregation {
  flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * Builds an idempotent graceful-shutdown handler. On the first signal it closes
 * the Nest app (draining in-flight requests, running module-destroy hooks) and
 * then flushes buffered error aggregation (e.g. Sentry) so 5xx errors captured
 * just before a SIGTERM/restart are not lost. The flush runs even if close
 * throws, and the process exits afterwards regardless.
 */
export function createGracefulShutdownHandler(
  app: ClosableApp,
  errorAggregation: FlushableAggregation,
  onExit: () => void = () => process.exit(0),
  flushTimeoutMs = 2000,
): () => Promise<void> {
  let shuttingDown = false;
  return async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      // Ignore close errors — still attempt to flush buffered errors below.
    } finally {
      try {
        await errorAggregation.flush(flushTimeoutMs);
      } finally {
        onExit();
      }
    }
  };
}

/** Where a failed start reports to — injectable so the fatal path is unit-testable. */
export interface BootstrapFailureSinks {
  logError(message: string): void;
  exit(code: number): void;
}

const processSinks: BootstrapFailureSinks = {
  // console, not the Nest/Winston logger: a start can fail before that logger
  // exists, and this line is the only trace the failure leaves in `docker logs`.
  logError: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

function safeBootstrapFailureDetails(error: unknown): string {
  const sanitized = sanitizeLogValue(error);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return 'errorName=Error';
  }

  const record = sanitized as Record<string, unknown>;
  const errorName = typeof record.name === 'string' ? record.name : 'Error';
  const rawStartupCode =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'startupCode')?.value
      : undefined;
  const startupCode =
    typeof rawStartupCode === 'string' &&
    [
      'INVALID_APP_PORT',
      'OBJECT_STORAGE_NOT_CONFIGURED',
      'OBJECT_STORAGE_DELIVERY_URL_INVALID',
      'OBJECT_STORAGE_DELIVERY_URL_REQUIRED',
      'OBJECT_STORAGE_POLICY_UNAVAILABLE',
    ].includes(rawStartupCode)
      ? rawStartupCode
      : undefined;
  const source =
    typeof record.stack === 'string'
      ? record.stack.split('\n').find((line) => line.startsWith('at '))
      : undefined;
  return [
    `errorName=${errorName}`,
    startupCode ? `startupCode=${startupCode}` : undefined,
    source ? `source=${source}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Runs the bootstrap and makes a failed start loud and fatal.
 *
 * Unawaited, a rejected bootstrap reaches the process-wide unhandled-rejection
 * guard, which reports and keeps running — right for a stray runtime promise,
 * wrong for a start that never reached `listen`. On the test server that left a
 * process with no HTTP listener and no log line (a missing
 * OBJECT_STORAGE_DELIVERY_URL made UploadService.onModuleInit throw), and it was
 * worked around by swapping `app.listen` for a raw `server.listen`: that skips
 * `app.init()`, so every /api/v1 route answered 404 while /healthz stayed green.
 *
 * Exiting non-zero lets the orchestrator restart the container and surface the
 * failure, and the log line says why.
 */
export async function runBootstrap(
  start: () => Promise<void>,
  sinks: BootstrapFailureSinks = processSinks,
  errorAggregation: FlushableAggregation & {
    captureError?(error: unknown, context: Record<string, string>): void;
  } = getStartupErrorAggregation(),
): Promise<void> {
  try {
    await start();
  } catch (error) {
    try {
      errorAggregation.captureError?.(error, {
        component: 'bootstrap',
        operation: 'start',
        kind: 'process',
      });
    } catch {
      // An optional telemetry provider must never own the fatal path.
    }
    try {
      await flushWithDeadline(errorAggregation, 2000);
    } catch {
      // Keep the process-exit guarantee even for a broken provider.
    }
    try {
      sinks.logError(
        `[bootstrap] Application failed to start; ${safeBootstrapFailureDetails(error)}; exiting with code 1.`,
      );
    } catch {
      // Nowhere left to write the reason; exiting is what still matters.
    } finally {
      sinks.exit(1);
    }
  }
}

async function bootstrap() {
  const config = getServerConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  const app = await NestFactory.create(AppModule, buildNestFactoryOptions());
  const errorAggregation = setupApp(app);

  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('NestJS Lesson API')
      .setDescription('API documentation for the NestJS lesson project')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, swaggerDocument, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  app.get(RealtimeGateway).attach(app.getHttpServer());
  app.get(ChatGateway).attach(app.getHttpServer(), {
    corsOrigin: resolveCorsOriginChecker(),
  });

  const port = resolveAppPort(config['APP_PORT'] ?? 3000);
  await app.listen(port);

  // Drain and flush buffered error aggregation on orchestrator shutdown.
  const shutdown = createGracefulShutdownHandler(app, errorAggregation);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  void runBootstrap(bootstrap);
}
