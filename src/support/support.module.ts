import { Module } from '@nestjs/common';
import { AdminUserModule } from 'src/admin-user/admin-user.module';
import { SupportAdminController } from './support-admin.controller';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [AdminUserModule],
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService],
  // ChatService 要用 isSupportAgent 做陌生人开关豁免。
  exports: [SupportService],
})
export class SupportModule {}
