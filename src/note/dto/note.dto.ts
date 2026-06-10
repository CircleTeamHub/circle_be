import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const NOTE_STATUS = ['ACTIVE', 'UNLISTED', 'DELETED'] as const;
export type NoteStatus = (typeof NOTE_STATUS)[number];

/** Statuses a client is allowed to set — excludes the soft-delete sentinel */
export const NOTE_WRITABLE_STATUS = ['ACTIVE', 'UNLISTED'] as const;
export type NoteWritableStatus = (typeof NOTE_WRITABLE_STATUS)[number];

export const NOTE_MEDIA_TYPE = ['IMAGE', 'VIDEO'] as const;
export type NoteMediaType = (typeof NOTE_MEDIA_TYPE)[number];

@ValidatorConstraint({ name: 'uniqueMediaSortOrder', async: false })
class UniqueMediaSortOrderConstraint implements ValidatorConstraintInterface {
  validate(value: CreateNoteMediaDto[] | undefined) {
    if (!value) return true;
    const sortOrders = value.map((item) => item.sortOrder);
    return new Set(sortOrders).size === sortOrders.length;
  }

  defaultMessage() {
    return 'media sortOrder must be unique';
  }
}

export class CreateNoteMediaDto {
  @ApiProperty({ enum: NOTE_MEDIA_TYPE })
  @IsEnum(NOTE_MEDIA_TYPE)
  type: NoteMediaType;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  // Restrict to a safe storage-key charset and reject `..` so a crafted key
  // cannot smuggle path traversal or markup into stored data.
  @Matches(/^(?!.*\.\.)[A-Za-z0-9._/-]+$/, {
    message: 'objectKey contains invalid characters',
  })
  objectKey: string;

  @ApiProperty()
  @IsUrl({ require_tld: false })
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  height?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  posterUrl?: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  sortOrder: number;
}

export class CreateNoteDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  content?: string;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  contentJson?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(50)
  groupIds?: string[];

  @ApiPropertyOptional({ enum: NOTE_WRITABLE_STATUS })
  @IsOptional()
  @IsEnum(NOTE_WRITABLE_STATUS)
  status?: NoteWritableStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiProperty({ type: [CreateNoteMediaDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateNoteMediaDto)
  @Validate(UniqueMediaSortOrderConstraint)
  media: CreateNoteMediaDto[];
}

export class UpdateNoteDto extends CreateNoteDto {}

// 单独更新一条 note 的 group 归属。前端"批量调分组成员"流程要避免对每个 note 做
// fetch-detail-then-replace-all 的 N+1（参考 review #59）；这个 DTO 让前端只发 groupIds 一项。
export class UpdateNoteGroupIdsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ArrayMaxSize(50)
  groupIds: string[];
}

export class SetPinnedDto {
  @ApiProperty()
  @IsBoolean()
  pinned: boolean;
}

export class SetNoteAvailableDto {
  @ApiProperty()
  @IsBoolean()
  available: boolean;
}

export class ListNotesQueryDto {
  @ApiPropertyOptional({ enum: NOTE_STATUS })
  @IsOptional()
  @IsEnum(NOTE_STATUS)
  status?: NoteStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class CreateNoteShareLinkDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @ApiPropertyOptional({ enum: NOTE_WRITABLE_STATUS })
  @IsOptional()
  @IsEnum(NOTE_WRITABLE_STATUS)
  status?: NoteWritableStatus;

  @ApiPropertyOptional({ enum: ['ungrouped'] })
  @IsOptional()
  @IsEnum(['ungrouped'])
  group?: 'ungrouped';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  noteIds?: string[];
}

export class NoteShareLinkDto {
  @ApiProperty() id: string;
  @ApiProperty() token: string;
  @ApiProperty() url: string;
  @ApiPropertyOptional() expiresAt: Date | null;
  @ApiPropertyOptional() revokedAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class CreateNoteGroupDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name: string;
}

export class UpdateNoteGroupDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name: string;
}

export class ReorderNoteGroupsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  groupIds: string[];
}

export class NoteGroupDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() sortOrder: number;
  @ApiProperty() noteCount: number;
}

export class NoteMediaDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NOTE_MEDIA_TYPE }) type: NoteMediaType;
  @ApiProperty() objectKey: string;
  @ApiProperty() url: string;
  @ApiPropertyOptional() mimeType: string | null;
  @ApiPropertyOptional() size: number | null;
  @ApiPropertyOptional() width: number | null;
  @ApiPropertyOptional() height: number | null;
  @ApiPropertyOptional() durationMs: number | null;
  @ApiPropertyOptional() posterUrl: string | null;
  @ApiProperty() sortOrder: number;
}

export class NoteSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() ownerId: string;
  @ApiProperty() canEdit: boolean;
  @ApiProperty() title: string;
  @ApiPropertyOptional() contentPreview: string | null;
  @ApiProperty({ enum: NOTE_STATUS }) status: NoteStatus;
  @ApiProperty() available: boolean;
  @ApiProperty() pinned: boolean;
  @ApiProperty({ type: [Object] }) groups: { id: string; name: string }[];
  @ApiPropertyOptional() cover: {
    id: string;
    type: NoteMediaType;
    url: string;
  } | null;
  @ApiProperty() imageCount: number;
  @ApiProperty() videoCount: number;
  @ApiProperty() mediaCount: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class NoteDetailDto extends NoteSummaryDto {
  @ApiPropertyOptional() content: string | null;
  @ApiPropertyOptional({ type: [Object] }) contentJson?:
    | Record<string, unknown>[]
    | null;
  @ApiProperty({ type: [NoteMediaDto] }) media: NoteMediaDto[];
}
