import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaCleanup } from './circle-plaza.cleanup';
import { CirclePlazaService } from './circle-plaza.service';

@Module({
  imports: [RealtimeModule, NotificationModule, MembershipPolicyModule],
  controllers: [CirclePlazaController],
  providers: [CirclePlazaService, CirclePlazaCleanup],
})
export class CirclePlazaModule {}
