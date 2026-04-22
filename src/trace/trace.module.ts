import { Module } from '@nestjs/common';
import { TraceController } from './trace.controller';
import { TraceService } from './trace.service';

@Module({
  controllers: [TraceController],
  providers: [TraceService],
})
export class TraceModule {}
