import { Module } from '@nestjs/common';
import { AdminCommerceController } from './admin-commerce.controller';
import { AdminCommerceService } from './admin-commerce.service';
@Module({
  controllers: [AdminCommerceController],
  providers: [AdminCommerceService],
})
export class AdminCommerceModule {}
