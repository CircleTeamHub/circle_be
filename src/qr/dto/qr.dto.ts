import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { QrTokenTypeDto } from '../qr.types';

export class IssueQrTokenDto {
  @ApiProperty({ enum: ['USER', 'GROUP', 'CIRCLE'] })
  @IsIn(['USER', 'GROUP', 'CIRCLE'])
  type: QrTokenTypeDto;

  /** USER 名片码不带 targetId(只能签自己);GROUP/CIRCLE 必填。 */
  @ApiPropertyOptional({ example: 'uuid-of-conversation-or-circle' })
  @IsOptional()
  @IsUUID()
  targetId?: string;
}
