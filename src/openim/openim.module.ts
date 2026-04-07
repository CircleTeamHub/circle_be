import { Module } from '@nestjs/common';
import { OpenimService } from './openim.service';

@Module({
  providers: [OpenimService],
  exports: [OpenimService],
})
export class OpenimModule {}
