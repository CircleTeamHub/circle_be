import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from 'src/decorators/trim.decorator';
import { MAX_PAGE } from 'src/common/pagination';

export const NOTE_RATING_CASE_KINDS = ['BURST', 'APPEAL'] as const;
export const NOTE_RATING_CASE_STATUSES = ['PENDING', 'RESOLVED'] as const;
/** BURST cases take RELEASE / VOID; APPEAL cases take UPHOLD / REVOKE. */
export const NOTE_RATING_CASE_ACTIONS = [
  'RELEASE',
  'VOID',
  'UPHOLD',
  'REVOKE',
] as const;
export type NoteRatingCaseAction = (typeof NOTE_RATING_CASE_ACTIONS)[number];

export class ListNoteRatingCasesQueryDto {
  @ApiPropertyOptional({ enum: NOTE_RATING_CASE_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(NOTE_RATING_CASE_STATUSES)
  status?: (typeof NOTE_RATING_CASE_STATUSES)[number];

  @ApiPropertyOptional({ enum: NOTE_RATING_CASE_KINDS })
  @IsOptional()
  @IsIn(NOTE_RATING_CASE_KINDS)
  kind?: (typeof NOTE_RATING_CASE_KINDS)[number];

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ResolveNoteRatingCaseDto {
  @ApiProperty({ enum: NOTE_RATING_CASE_ACTIONS })
  @IsIn(NOTE_RATING_CASE_ACTIONS)
  action: NoteRatingCaseAction;

  @ApiPropertyOptional({ maxLength: 500, description: 'Internal note.' })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(500)
  note?: string;
}

export class NoteRatingCaseUserDto {
  @ApiProperty() id: string;
  @ApiProperty() accountId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) nickname:
    | string
    | null;
  @ApiPropertyOptional({ nullable: true, type: String }) avatarUrl:
    | string
    | null;
}

export class NoteRatingCaseRaterDto extends NoteRatingCaseUserDto {
  @ApiProperty() creditScore: number;
  @ApiProperty() registeredAt: Date;
}

export class NoteRatingCaseNoteDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'null once the note was purged from the recycle bin.',
  })
  title: string | null;
  @ApiPropertyOptional({ nullable: true, type: String })
  status: string | null;
}

export class NoteRatingCaseRatingDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: NoteRatingCaseNoteDto }) note: NoteRatingCaseNoteDto;
  @ApiProperty({ type: NoteRatingCaseRaterDto }) rater: NoteRatingCaseRaterDto;
  @ApiProperty({ enum: ['GOOD', 'BAD'] }) value: 'GOOD' | 'BAD';
  @ApiPropertyOptional({ nullable: true, type: String }) reason: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) comment: string | null;
  @ApiProperty({ enum: ['COUNTED', 'HELD', 'VOID'] }) status:
    | 'COUNTED'
    | 'HELD'
    | 'VOID';
  @ApiProperty() createdAt: Date;
}

export class NoteRatingCaseDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NOTE_RATING_CASE_KINDS }) kind: 'BURST' | 'APPEAL';
  @ApiProperty({ enum: NOTE_RATING_CASE_STATUSES }) status:
    | 'PENDING'
    | 'RESOLVED';
  @ApiProperty({ type: NoteRatingCaseUserDto }) owner: NoteRatingCaseUserDto;
  @ApiPropertyOptional({ nullable: true, type: String }) ownerReason:
    | string
    | null;
  @ApiPropertyOptional({ nullable: true, enum: NOTE_RATING_CASE_ACTIONS })
  resolution: NoteRatingCaseAction | null;
  @ApiPropertyOptional({ nullable: true, type: String }) resolutionNote:
    | string
    | null;
  @ApiPropertyOptional({ nullable: true, type: NoteRatingCaseUserDto })
  resolvedBy: NoteRatingCaseUserDto | null;
  @ApiPropertyOptional({ nullable: true, type: Date }) resolvedAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: [NoteRatingCaseRatingDto] })
  ratings: NoteRatingCaseRatingDto[];
}

export class NoteRatingCaseListDto {
  @ApiProperty({ type: [NoteRatingCaseDto] }) items: NoteRatingCaseDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() hasMore: boolean;
}
