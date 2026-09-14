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
import { MaxJsonLength } from 'src/common/validation';

/**
 * JSON.stringify(payload).length 的上限。APP 拼的最大快照是一条 4000 字（聊天正文
 * 上限 MAX_TEXT_LENGTH）的文本消息加元数据，约 5000；带头像与 4 个图标地址的名片、
 * 带预签名地址的图片/语音都远在其下。此前 payload 只有 @IsObject，大小不设防。
 */
export const COLLECTION_PAYLOAD_MAX_JSON_LENGTH = 8192;

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

  @ApiPropertyOptional({
    type: Object,
    description: `JSON 序列化后不超过 ${COLLECTION_PAYLOAD_MAX_JSON_LENGTH} 个字符`,
  })
  @IsOptional()
  @IsObject()
  @MaxJsonLength(COLLECTION_PAYLOAD_MAX_JSON_LENGTH)
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
