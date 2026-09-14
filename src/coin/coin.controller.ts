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
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CoinService } from './coin.service';
import { CoinTransactionDto, SendGiftDto, WalletDto } from './dto/coin.dto';

// 与 fancy-number / group-expansion 的 requireIdempotencyKey 同上限。
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

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
    const key = idempotencyKey?.trim() ?? '';
    if (key.length === 0) {
      throw new BadRequestException('idempotency-key header is required');
    }
    // 键直接落库当唯一索引；不封顶等于让客户端决定索引行宽。与 fancy-number 同上限。
    if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new BadRequestException(
        `idempotency-key header must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      );
    }
    return this.coinService.sendGift(
      req.user.userId,
      dto.recipientId,
      dto.amount,
      key,
      dto.message,
    );
  }
}
