import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { GroupExpansionErrorCode } from 'src/common/app-error-codes';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  GroupExpansionOrdersResultDto,
  GroupExpansionCircleQueryDto,
  GroupExpansionProductsResultDto,
  GroupExpansionPurchaseResultDto,
  ListGroupExpansionOrdersQueryDto,
  PurchaseGroupExpansionDto,
} from './dto/group-expansion.dto';
import { GroupExpansionService } from './group-expansion.service';

@ApiTags('Mall - Group Expansions')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('group-expansions')
export class GroupExpansionController {
  constructor(private readonly service: GroupExpansionService) {}

  @Get('products')
  @ApiOperation({ summary: 'List expansion cards for an owned group' })
  @ApiOkResponse({ type: GroupExpansionProductsResultDto })
  getProducts(
    @Query() query: GroupExpansionCircleQueryDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.getProducts(req.user.userId, query.circleId);
  }

  @Get('orders')
  @ApiOperation({ summary: 'List expansion purchases for an owned group' })
  @ApiOkResponse({ type: GroupExpansionOrdersResultDto })
  getOrders(
    @Query() query: ListGroupExpansionOrdersQueryDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.getOrders(
      req.user.userId,
      query.circleId,
      query.cursor,
      query.limit,
    );
  }

  @Post('purchases')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Buy and apply a permanent group expansion card' })
  @ApiOkResponse({ type: GroupExpansionPurchaseResultDto })
  purchase(
    @Body() dto: PurchaseGroupExpansionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.service.purchase(
      req.user.userId,
      dto.circleId,
      dto.productId,
      this.requireIdempotencyKey(idempotencyKey),
    );
  }

  private requireIdempotencyKey(value: string | undefined): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new BadRequestException({
        message: 'Idempotency-Key header is required',
        errorCode: GroupExpansionErrorCode.InvalidIdempotencyKey,
      });
    }
    if (normalized.length > 128) {
      throw new BadRequestException({
        message: 'Idempotency-Key is too long',
        errorCode: GroupExpansionErrorCode.InvalidIdempotencyKey,
      });
    }
    return normalized;
  }
}
