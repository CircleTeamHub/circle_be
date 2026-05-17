// Copyright (c) 2022 toimc<admin@wayearn.com>
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT
import 'module-alias/register';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupApp } from './setup';
import { RealtimeGateway } from './realtime/realtime.gateway';
// import { AllExceptionFilter } from './filters/all-exception.filter';
import { getServerConfig } from './config/server.config';

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

  throw new Error(`Invalid APP_PORT value: ${String(value)}`);
}

type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

export function resolveCorsOriginChecker(
  env: NodeJS.ProcessEnv = process.env,
): (origin: string | undefined, callback: CorsOriginCallback) => void {
  const isProduction = env.NODE_ENV === 'production';
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Dev/test: also allow localhost/loopback on any port. Avoid `cors: true`
  // (reflect-any-origin) which lets any page on the LAN ride the user's
  // credentials.
  const devPatterns: RegExp[] = isProduction
    ? []
    : [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
        /^https?:\/\/\[::1\](:\d+)?$/,
        /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
        /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
      ];

  return (origin, callback) => {
    // Same-origin / curl / mobile webviews have no Origin header — allow.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (devPatterns.some((re) => re.test(origin))) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`), false);
  };
}

async function bootstrap() {
  const config = getServerConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: resolveCorsOriginChecker(),
      credentials: true,
    },
  });
  setupApp(app);

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

  const port = resolveAppPort(config['APP_PORT'] ?? 3000);
  await app.listen(port);
}

if (require.main === module) {
  bootstrap();
}
