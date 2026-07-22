import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { AdminAuditService } from './admin-audit.service';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [AdminUserController],
  providers: [AdminUserService, AdminAuditService],
})
export class AdminUserModule {}
