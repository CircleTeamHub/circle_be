import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { AvatarFrameModule } from 'src/avatar-frame/avatar-frame.module';
import { UploadModule } from 'src/upload/upload.module';

@Global()
@Module({
  imports: [
    ConfigModule,
    RealtimeModule,
    PrivacySettingsModule,
    AvatarFrameModule,
    UploadModule,
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
