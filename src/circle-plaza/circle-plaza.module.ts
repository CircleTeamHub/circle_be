import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaService } from './circle-plaza.service';

@Module({
  imports: [RealtimeModule, NotificationModule],
  controllers: [CirclePlazaController],
  providers: [CirclePlazaService],
})
export class CirclePlazaModule {}
