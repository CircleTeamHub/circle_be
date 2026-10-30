import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAssistantSubscriptionDto {
  @IsUUID()
  circleId: string;

  @ApiPropertyOptional({
    type: [String],
    description: '圈子城市的可选子集；省略或空数组表示跟随圈子最新城市范围',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  @MaxLength(100, { each: true })
  @IsOptional()
  cities?: string[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  pushEnabled?: boolean;
}

export class UpdateAssistantSubscriptionDto {
  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  @MaxLength(100, { each: true })
  @IsOptional()
  cities?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  pushEnabled?: boolean;
}
