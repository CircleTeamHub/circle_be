import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class ConversationPreferencesDto {
  @ApiPropertyOptional({ description: '置顶' })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiPropertyOptional({ description: '免打扰' })
  @IsOptional()
  @IsBoolean()
  muted?: boolean;
}
