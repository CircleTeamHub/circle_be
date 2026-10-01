import {
  Controller,
  Get,
  Query,
  UseGuards,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import { AdminCommerceService } from './admin-commerce.service';
import {
  CommerceQueryDto,
  MembershipQueryDto,
  OwnershipQueryDto,
} from './admin-commerce.dto';
@Controller('admin/commerce')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
@RequireAdminPermission('COMMERCE_MANAGE')
export class AdminCommerceController {
  constructor(private readonly service: AdminCommerceService) {}
  @Get('memberships') memberships(@Query() query: MembershipQueryDto) {
    return this.service.memberships(query);
  }
  @Get('memberships/:userId/grants') grants(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: CommerceQueryDto,
  ) {
    return this.service.grants(userId, query);
  }
  @Get('fancy-number-orders') orders(@Query() query: CommerceQueryDto) {
    return this.service.orders(query);
  }
  @Get('fancy-number-ownership') ownership(@Query() query: OwnershipQueryDto) {
    return this.service.ownership(query);
  }
}
