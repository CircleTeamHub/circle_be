import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CollectionType } from 'src/generated/prisma';

export class ListCollectionsQueryDto {
  @ApiPropertyOptional({ enum: CollectionType })
  @IsOptional()
  @IsEnum(CollectionType)
  type?: CollectionType;
}

export class CreateCollectionDto {
  @ApiProperty({ enum: CollectionType })
  @IsEnum(CollectionType)
  type: CollectionType;

  @ApiProperty({ example: '收藏聊天记录' })
  @IsString()
  @MaxLength(80)
  title: string;

  @ApiPropertyOptional({ example: '一段重要聊天' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  summary?: string;

  @ApiPropertyOptional({ example: 'message-id-or-note-id' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceID?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  @Type(() => Object)
  payload?: Record<string, unknown>;
}

export class UserCollectionDto {
  @ApiProperty() id: string;
  @ApiProperty() userID: string;
  @ApiProperty({ enum: CollectionType }) type: CollectionType;
  @ApiProperty() title: string;
  @ApiPropertyOptional() summary: string | null;
  @ApiPropertyOptional() sourceID: string | null;
  @ApiPropertyOptional({ type: Object }) payload: unknown;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
