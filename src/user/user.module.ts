import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { OpenimModule } from 'src/openim/openim.module';

@Global()
@Module({
  imports: [ConfigModule, RealtimeModule, PrivacySettingsModule, OpenimModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
