import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  ApproveSupportRechargeOrderDto,
  CreateSupportRechargePaymentCodeDto,
  ListSupportRechargeOrdersQueryDto,
  RejectSupportRechargeOrderDto,
  SetSupportRechargePaymentCodeEnabledDto,
} from './support-recharge.dto';
import { SupportRechargeService } from './support-recharge.service';

@ApiTags('Admin · Support Recharge')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/support/recharge')
export class SupportRechargeAdminController {
  constructor(private readonly recharge: SupportRechargeService) {}

  @Get('payment-codes')
  @ApiOperation({ summary: '列出充值客服收款码配置' })
  listPaymentCodes() {
    return this.recharge.listPaymentCodes();
  }

  @Post('payment-codes')
  @ApiOperation({ summary: '登记当前管理员刚上传的收款码' })
  createPaymentCode(
    @Req() req: RequestWithUser,
    @Body() dto: CreateSupportRechargePaymentCodeDto,
  ) {
    return this.recharge.createPaymentCode(this.operator(req), dto);
  }

  @Patch('payment-codes/:id/enabled')
  @ApiOperation({ summary: '启用或停用收款码' })
  setPaymentCodeEnabled(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetSupportRechargePaymentCodeEnabledDto,
  ) {
    return this.recharge.setPaymentCodeEnabled(
      this.operator(req),
      id,
      dto.enabled,
    );
  }

  @Get('orders')
  @ApiOperation({ summary: '列出充值客服申请单' })
  listOrders(@Query() query: ListSupportRechargeOrdersQueryDto) {
    return this.recharge.listOrders(query);
  }

  @Post('orders/:id/approve')
  @ApiOperation({ summary: '确认真实到账并幂等发放权益' })
  approveOrder(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveSupportRechargeOrderDto,
  ) {
    return this.recharge.approveOrder(this.operator(req), id, dto);
  }

  @Post('orders/:id/reject')
  @ApiOperation({ summary: '驳回充值申请并通知用户' })
  rejectOrder(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectSupportRechargeOrderDto,
  ) {
    return this.recharge.rejectOrder(this.operator(req), id, dto.reason);
  }

  private operator(req: RequestWithUser) {
    return {
      userId: req.user.userId,
      accountId: req.user.accountId,
    };
  }
}
