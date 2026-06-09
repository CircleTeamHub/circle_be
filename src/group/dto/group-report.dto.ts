import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export const GROUP_REPORT_CATEGORIES = [
  'harassment',
  'spam',
  'impersonation',
  'fraud',
  'other',
] as const;

export class ReportGroupDto {
  @ApiProperty({
    enum: GROUP_REPORT_CATEGORIES,
    example: 'spam',
  })
  @IsEnum(GROUP_REPORT_CATEGORIES)
  category: (typeof GROUP_REPORT_CATEGORIES)[number];

  @ApiProperty({
    example: 'Repeated spam messages in the group.',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Optional evidence references such as object keys or URLs.',
    example: ['reports/group-chat-12345.png'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @Matches(/^[^<>]+$/, {
    each: true,
    message: 'evidence entries contain invalid characters',
  })
  evidence?: string[];
}
