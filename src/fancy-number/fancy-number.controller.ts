import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  CheckCustomFancyNumberQueryDto,
  CustomFancyNumberAvailabilityDto,
  FancyNumberListDto,
  FancyNumberPurchaseResultDto,
  ListFancyNumbersQueryDto,
  MyFancyNumberDto,
  PurchaseFancyNumberDto,
  PurchaseCustomFancyNumberDto,
  RenewFancyNumberDto,
  SwitchCustomFancyNumberDto,
  SwitchFancyNumberDto,
} from './dto/fancy-number.dto';
import { FancyNumberService } from './fancy-number.service';

@ApiTags('Mall - Fancy Numbers')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('mall/fancy-numbers')
export class FancyNumberController {
  constructor(private readonly service: FancyNumberService) {}

  @Get()
  @ApiOperation({ summary: 'List available fancy numbers' })
  @ApiOkResponse({ type: FancyNumberListDto })
  list(@Query() query: ListFancyNumbersQueryDto, @Req() req: RequestWithUser) {
    return this.service.listAvailable(req.user.userId, query);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get my current fancy number lease' })
  @ApiOkResponse({ type: MyFancyNumberDto })
  getMine(@Req() req: RequestWithUser) {
    return this.service.getMine(req.user.userId);
  }

  @Get('availability')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check whether a custom fancy number is available' })
  @ApiOkResponse({ type: CustomFancyNumberAvailabilityDto })
  checkCustomAvailability(
    @Query() query: CheckCustomFancyNumberQueryDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.checkCustomAvailability(req.user.userId, query.value);
  }

  @Post('custom/purchase')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Purchase a custom six-character fancy number' })
  @ApiOkResponse({ type: FancyNumberPurchaseResultDto })
  @HttpCode(HttpStatus.OK)
  purchaseCustom(
    @Body() dto: PurchaseCustomFancyNumberDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.service.purchaseCustom(
      req.user.userId,
      dto.value,
      dto.months,
      this.requireIdempotencyKey(idempotencyKey),
      undefined,
      dto.expectedUnitPrice,
    );
  }

  @Post('custom/switch')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Switch to a custom permanent fancy number' })
  @ApiOkResponse({ type: FancyNumberPurchaseResultDto })
  @HttpCode(HttpStatus.OK)
  switchPermanentCustom(
    @Body() dto: SwitchCustomFancyNumberDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.service.switchPermanentCustom(
      req.user.userId,
      dto.value,
      this.requireIdempotencyKey(idempotencyKey),
      undefined,
      dto.expectedUnitPrice,
    );
  }

  @Post(':id/purchase')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Purchase a fancy number' })
  @ApiOkResponse({ type: FancyNumberPurchaseResultDto })
  @HttpCode(HttpStatus.OK)
  purchase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PurchaseFancyNumberDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.service.purchase(
      req.user.userId,
      id,
      dto.months,
      this.requireIdempotencyKey(idempotencyKey),
      undefined,
      dto.expectedUnitPrice,
    );
  }

  @Post(':id/switch')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Switch my permanent fancy number for 100 points' })
  @ApiOkResponse({ type: FancyNumberPurchaseResultDto })
  @HttpCode(HttpStatus.OK)
  switchPermanent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SwitchFancyNumberDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.service.switchPermanent(
      req.user.userId,
      id,
      this.requireIdempotencyKey(idempotencyKey),
      undefined,
      dto.expectedUnitPrice,
    );
  }

  @Post('renew')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Renew my active fancy number' })
  @ApiOkResponse({ type: FancyNumberPurchaseResultDto })
  @HttpCode(HttpStatus.OK)
  renew(
    @Body() dto: RenewFancyNumberDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithUser,
  ) {
    return this.service.renew(
      req.user.userId,
      dto.months,
      this.requireIdempotencyKey(idempotencyKey),
      undefined,
      dto.expectedUnitPrice,
    );
  }

  private requireIdempotencyKey(value: string | undefined): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    if (normalized.length > 128) {
      throw new BadRequestException('Idempotency-Key is too long');
    }
    return normalized;
  }
}
