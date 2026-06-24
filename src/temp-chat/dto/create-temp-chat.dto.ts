import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTempChatDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 30, default: '临时聊天' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  title?: string;

  @ApiPropertyOptional({
    minimum: 30,
    maximum: 10080,
    default: 4320,
    description: '有效期（分钟），默认 3 天，最长 7 天',
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(10080)
  ttlMinutes?: number;

  @ApiPropertyOptional({ minimum: 2, maximum: 50, default: 50 })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(50)
  maxMembers?: number;
}
