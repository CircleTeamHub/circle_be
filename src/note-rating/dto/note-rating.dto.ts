import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from 'src/decorators/trim.decorator';
import {
  NOTE_RATING_APPEAL_REASON_MAX,
  NOTE_RATING_COMMENT_MAX,
} from '../note-rating.constants';

export const NOTE_RATING_VALUES = ['GOOD', 'BAD'] as const;
export type NoteRatingValueInput = (typeof NOTE_RATING_VALUES)[number];
export const NOTE_RATING_REASONS = [
  'INACCURATE',
  'EXPIRED',
  'BAD_EXPERIENCE',
  'OTHER',
] as const;
export type NoteRatingReasonInput = (typeof NOTE_RATING_REASONS)[number];

/**
 * Shape only. The cross-field rules (BAD needs a reason, OTHER needs text,
 * GOOD carries neither) are checked once in NoteRatingService.rate.
 */
export class CreateNoteRatingDto {
  @ApiProperty({ enum: NOTE_RATING_VALUES })
  @IsIn(NOTE_RATING_VALUES)
  value: NoteRatingValueInput;

  @ApiPropertyOptional({
    enum: NOTE_RATING_REASONS,
    description: 'Required for BAD; not allowed for GOOD.',
  })
  @IsOptional()
  @IsIn(NOTE_RATING_REASONS)
  reason?: NoteRatingReasonInput;

  @ApiPropertyOptional({
    maxLength: NOTE_RATING_COMMENT_MAX,
    description: 'Required when reason is OTHER; only allowed for BAD.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(NOTE_RATING_COMMENT_MAX)
  comment?: string;
}

export class NoteRatingCountersDto {
  @ApiProperty({ description: 'Source (root) note the counters belong to.' })
  noteId: string;
  @ApiProperty({ description: 'Asia/Shanghai month of the counters, YYYY-MM.' })
  month: string;
  @ApiProperty() goodCount: number;
  @ApiProperty() badCount: number;
}

export class NoteRatingSummaryDto extends NoteRatingCountersDto {
  @ApiProperty({
    description:
      'Whether the viewer may rate now (today’s per-note quota aside, see goodFull/badFull).',
  })
  canRate: boolean;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'NOTE_RATING_* code explaining why the viewer cannot rate.',
  })
  reason: string | null;
  @ApiPropertyOptional({ nullable: true, type: Date })
  nextRatableAt: Date | null;
  @ApiProperty({
    description:
      'The viewer already gave a 好评 today (Shanghai day); 好评 and 差评 are one each per day. `reason` only turns into NOTE_RATING_RATER_DAILY_LIMIT once both are used.',
  })
  goodRatedToday: boolean;
  @ApiProperty({ description: 'The viewer already gave a 差评 today.' })
  badRatedToday: boolean;
  @ApiProperty({ description: 'Today’s 5 counted good ratings are taken.' })
  goodFull: boolean;
  @ApiProperty({ description: 'Today’s 5 counted bad ratings are taken.' })
  badFull: boolean;
}

export class NoteRatingResultDto extends NoteRatingCountersDto {
  @ApiProperty() ratingId: string;
  @ApiProperty({
    enum: ['COUNTED', 'HELD'],
    description: 'HELD = paused by burst detection; not in the counters yet.',
  })
  status: 'COUNTED' | 'HELD';
  @ApiProperty({ description: 'When the viewer may rate this note again.' })
  nextRatableAt: Date;
}

export class NoteRatingAppealDto {
  @ApiProperty({ enum: ['PENDING', 'UPHELD', 'REVOKED'] })
  status: 'PENDING' | 'UPHELD' | 'REVOKED';
  @ApiProperty() reason: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional({ nullable: true, type: Date })
  resolvedAt: Date | null;
}

/** What the owner sees of a bad rating. Never carries the rater. */
export class NoteBadRatingDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NOTE_RATING_REASONS }) reason: NoteRatingReasonInput;
  @ApiPropertyOptional({ nullable: true, type: String })
  comment: string | null;
  @ApiProperty({ enum: ['COUNTED', 'HELD', 'VOID'] })
  status: 'COUNTED' | 'HELD' | 'VOID';
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional({ type: NoteRatingAppealDto, nullable: true })
  appeal: NoteRatingAppealDto | null;
  @ApiProperty() canAppeal: boolean;
}

export class NoteBadRatingListDto {
  @ApiProperty({ type: [NoteBadRatingDto] }) items: NoteBadRatingDto[];
  @ApiPropertyOptional({ nullable: true, type: String })
  nextCursor: string | null;
  @ApiProperty({ description: 'Appeals the owner may still file this month.' })
  appealsRemaining: number;
}

export class ListNoteBadRatingsQueryDto {
  @ApiPropertyOptional({ description: 'Last rating id of the previous page.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class AppealNoteRatingDto {
  @ApiProperty({ maxLength: NOTE_RATING_APPEAL_REASON_MAX })
  @IsString()
  @Trim()
  @IsNotEmpty()
  @MaxLength(NOTE_RATING_APPEAL_REASON_MAX)
  reason: string;
}
