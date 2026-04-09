import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class SendGiftDto {
  @ApiProperty({ example: 'uuid-of-recipient' })
  @IsUUID()
  recipientId: string;

  @ApiProperty({ example: 100, description: 'Number of coins to send (min 1)' })
  @IsInt()
  @Min(1)
  amount: number;

  @ApiPropertyOptional({ example: '生日快乐！' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  message?: string;
}

export class WalletDto {
  @ApiProperty() id: string;
  @ApiProperty() userID: string;
  @ApiProperty() balance: number;
  @ApiProperty() updatedAt: Date;
}

export class CoinTransactionDto {
  @ApiProperty() id: string;
  @ApiProperty() type: string;
  @ApiProperty() amount: number;
  @ApiProperty() balance: number;
  @ApiPropertyOptional() note: string | null;
  @ApiPropertyOptional() relatedID: string | null;
  @ApiProperty() createdAt: Date;
}
