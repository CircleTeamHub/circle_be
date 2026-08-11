import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { AdminUserAuditService } from './admin-user-audit.service';
import { AdminUserController } from './admin-user.controller';
import { AdminUserService } from './admin-user.service';
import { SessionRevocationOutboxProcessor } from './session-revocation-outbox.processor';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [AdminUserController],
  providers: [
    AdminUserService,
    AdminUserAuditService,
    SessionRevocationOutboxProcessor,
  ],
  // 治理侧与用户中心共用同一张 AdminAuditLog;客服配置也走这条链路,
  // 所以审计服务需要跨模块可注入,而不是每个模块各起一份。
  exports: [AdminUserAuditService],
})
export class AdminUserModule {}
