import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { AdminUserAuditService } from './admin-user-audit.service';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [AdminUserController],
  providers: [AdminUserService, AdminUserAuditService],
})
export class AdminUserModule {}
