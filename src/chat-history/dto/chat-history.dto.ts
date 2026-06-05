import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ChatHistoryQueryDto {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 100;

  @ApiPropertyOptional({
    description: 'Return messages with seq lower than this value',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeSeq?: number;
}

export class RestorableMessageDto {
  @ApiProperty() clientMsgID!: string;
  @ApiProperty() serverMsgID!: string;
  @ApiProperty() sendID!: string;
  @ApiProperty() recvID!: string;
  @ApiProperty() groupID!: string;
  @ApiProperty() senderNickname!: string;
  @ApiProperty() senderFaceUrl!: string;
  @ApiProperty() senderPlatformID!: number;
  @ApiProperty() sessionType!: number;
  @ApiProperty() msgFrom!: number;
  @ApiProperty() contentType!: number;
  @ApiProperty() status!: number;
  @ApiProperty() seq!: number;
  @ApiProperty() sendTime!: number;
  @ApiProperty() createTime!: number;
  @ApiProperty() content!: string;
  @ApiProperty() attachedInfo!: string;
  @ApiProperty() ex!: string;
  @ApiProperty() isRead!: boolean;
}

export class ChatHistoryMessagePageDto {
  @ApiProperty() conversationID!: string;
  @ApiProperty({ type: [RestorableMessageDto] })
  messages!: RestorableMessageDto[];
  @ApiProperty({
    description:
      'True when older messages remain below this page (or the per-request ' +
      'shard scan budget was reached). Keep paginating with nextBeforeSeq.',
  })
  hasMore!: boolean;
  @ApiProperty({
    nullable: true,
    description:
      'Cursor for the next (older) page: pass as beforeSeq. Null when there ' +
      'is nothing older to fetch.',
  })
  nextBeforeSeq!: number | null;
  @ApiProperty({
    nullable: true,
    description:
      "Conversation's authoritative oldest retained seq, from OpenIM's seq " +
      "collection. NOTE: conversation-global — not the caller's oldest " +
      'visible message. Null when no seq record exists.',
  })
  serverMinSeq!: number | null;
  @ApiProperty({
    nullable: true,
    description:
      "Conversation's authoritative newest seq, from OpenIM's seq " +
      'collection (conversation-global, not caller-specific). Null when no ' +
      'seq record exists.',
  })
  serverMaxSeq!: number | null;
}
