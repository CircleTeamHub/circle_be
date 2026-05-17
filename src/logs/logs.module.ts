import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { ConfigService } from '@nestjs/config';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';
import { createWinstonOptions } from '../logging/winston-options';

@Module({
  imports: [
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createWinstonOptions(configService),
    }),
  ],
  controllers: [LogsController],
  providers: [LogsService],
})
export class LogsModule {}
