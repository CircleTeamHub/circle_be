import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { RealtimeModule } from 'src/realtime/realtime.module';

@Global()
@Module({
  imports: [ConfigModule, RealtimeModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
