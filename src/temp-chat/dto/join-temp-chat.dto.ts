import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class JoinTempChatDto {
  @ApiPropertyOptional({ maxLength: 20, description: '访客昵称，缺省随机生成' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  displayName?: string;
}
