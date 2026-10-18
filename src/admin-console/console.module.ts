import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConsoleDiagnosticsInterceptor } from './console-diagnostics.interceptor';
import { Module } from '@nestjs/common';
import {
  AppOperationsController,
  ConsoleController,
  ConsoleToolController,
} from './console.controller';
import { ConsoleInsightsService } from './console-insights.service';
import { ConsoleKeysService, ConsoleKeyGuard } from './console-keys.service';
import { ConsoleOperationsService } from './console-operations.service';
import { ConsoleReleasesService } from './console-releases.service';
@Module({
  controllers: [
    ConsoleController,
    AppOperationsController,
    ConsoleToolController,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ConsoleDiagnosticsInterceptor },
    ConsoleInsightsService,
    ConsoleKeysService,
    ConsoleKeyGuard,
    ConsoleOperationsService,
    ConsoleReleasesService,
  ],
})
export class ConsoleModule {}
