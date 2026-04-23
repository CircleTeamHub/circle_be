import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CoinService } from './coin.service';
import {
  CoinTransactionDto,
  RechargeDto,
  SendGiftDto,
  WalletDto,
} from './dto/coin.dto';

@ApiTags('Coin')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('coin')
export class CoinController {
  constructor(private readonly coinService: CoinService) {}

  @Get('wallet')
  @ApiOperation({ summary: 'Get my wallet balance' })
  @ApiOkResponse({ type: WalletDto })
  getWallet(@Req() req: any): Promise<WalletDto> {
    return this.coinService.getWallet(req.user.userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'My coin transaction history (last 50)' })
  @ApiOkResponse({ type: [CoinTransactionDto] })
  getTransactions(@Req() req: any): Promise<CoinTransactionDto[]> {
    return this.coinService.getTransactions(req.user.userId);
  }

  @Post('recharge')
  @ApiOperation({ summary: 'Recharge points into my wallet' })
  @ApiOkResponse({ type: WalletDto })
  recharge(@Body() dto: RechargeDto, @Req() req: any): Promise<WalletDto> {
    return this.coinService.recharge(req.user.userId, dto.amount);
  }

  @Post('gift')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send coins to a friend' })
  @ApiNoContentResponse()
  sendGift(@Body() dto: SendGiftDto, @Req() req: any): Promise<void> {
    return this.coinService.sendGift(
      req.user.userId,
      dto.recipientId,
      dto.amount,
      dto.message,
    );
  }
}
