import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CoinService } from './coin.service';
import { CoinTransactionDto, SendGiftDto, WalletDto } from './dto/coin.dto';

@ApiTags('Coin')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('coin')
export class CoinController {
  constructor(private readonly coinService: CoinService) {}

  @Get('wallet')
  @ApiOperation({ summary: 'Get my wallet balance' })
  @ApiOkResponse({ type: WalletDto })
  getWallet(@Req() req: RequestWithUser): Promise<WalletDto> {
    return this.coinService.getWallet(req.user.userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'My coin transaction history (last 50)' })
  @ApiOkResponse({ type: [CoinTransactionDto] })
  getTransactions(@Req() req: RequestWithUser): Promise<CoinTransactionDto[]> {
    return this.coinService.getTransactions(req.user.userId);
  }

  @Post('gift')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send coins to a friend' })
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Unique per gift attempt. A retry with the same key is a no-op — it does not double-charge.',
  })
  @ApiNoContentResponse()
  sendGift(
    @Body() dto: SendGiftDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('idempotency-key header is required');
    }
    return this.coinService.sendGift(
      req.user.userId,
      dto.recipientId,
      dto.amount,
      idempotencyKey.trim(),
      dto.message,
    );
  }

  @Post('gift/card-sent')
  // round 2 review：@Throttle 只是元数据，没有 ThrottlerGuard 就不生效
  //（本应用有意不注册全局 ThrottlerGuard）。回执是会写库的端点，必须真限流。
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  markGiftCardSent(
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('idempotency-key header is required');
    }
    // #100：IM 卡片已由客户端送达的回执，阻止服务端补偿 cron 重复发卡。
    return this.coinService.markGiftCardSent(
      req.user.userId,
      idempotencyKey.trim(),
    );
  }
}
