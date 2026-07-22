import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import { createWinstonOptions } from './winston-options';

/**
 * Winston 根注册。此前寄生在 LogsModule 里 —— #97 删除死掉的 LogsController
 * 时险些连根拔掉唯一的 WinstonModule.forRootAsync（LOG_ON=true 的生产默认下
 * setup.ts 会 app.get(WINSTON_MODULE_NEST_PROVIDER)，boot 即崩）。
 * 现在日志注册独立成模块，与任何业务路由解耦。
 */
@Module({
  imports: [
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createWinstonOptions(configService),
    }),
  ],
})
export class WinstonLoggingModule {}
