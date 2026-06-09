import { Module } from '@nestjs/common';
import { OutboxController } from './outbox.controller';
import { OutboxService } from './outbox.service';

@Module({
  controllers: [OutboxController],
  providers: [OutboxService],
})
export class OutboxModule {}
