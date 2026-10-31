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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({
    type: [String],
    description: '动态关键词；省略或空数组表示关注全部动态',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(100, { each: true })
  @IsOptional()
  keywords?: string[];

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

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(100, { each: true })
  @IsOptional()
  keywords?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  pushEnabled?: boolean;
}

export class UpdateAssistantPreferencesDto {
  @ApiProperty({
    description: '笔记库里的笔记被来源作者打烊、下架或删除时提醒',
  })
  @IsBoolean()
  noteStatusAlerts: boolean;
}
