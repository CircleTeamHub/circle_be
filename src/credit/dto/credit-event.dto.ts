import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreditEventDto {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Signed change, e.g. -5' }) delta: number;
  @ApiProperty({ description: 'Score right after this change (0–100)' })
  scoreAfter: number;
  @ApiProperty({ example: 'FRIEND_REPORT' }) reason: string;
  @ApiPropertyOptional({
    description: 'Report category when the change came from a friend report',
    example: 'harassment',
  })
  category: string | null;
  @ApiProperty() createdAt: Date;
}
