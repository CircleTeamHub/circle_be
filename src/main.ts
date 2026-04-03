// Copyright (c) 2022 toimc<admin@wayearn.com>
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT
import 'module-alias/register';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupApp } from './setup';
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

async function bootstrap() {
  const config = getServerConfig();

  const app = await NestFactory.create(AppModule, {
    // 关闭整个nestjs日志
    // logger: flag && [],
    // logger: false,
    // 允许跨域
    cors: true,
    // logger: ['error', 'warn'],
  });
  setupApp(app);

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

  const port = resolveAppPort(config['APP_PORT'] ?? 3000);
  await app.listen(port);
}

if (require.main === module) {
  bootstrap();
}
