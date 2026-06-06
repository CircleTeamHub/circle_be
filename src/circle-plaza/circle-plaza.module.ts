import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaService } from './circle-plaza.service';

@Module({
  imports: [RealtimeModule],
  controllers: [CirclePlazaController],
  providers: [CirclePlazaService],
})
export class CirclePlazaModule {}
