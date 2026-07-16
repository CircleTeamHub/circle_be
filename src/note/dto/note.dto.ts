import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
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

export const NOTE_EXPORT_FORMAT = ['IMAGE', 'PDF', 'IMAGES', 'VIDEOS'] as const;
export type NoteExportFormat = (typeof NOTE_EXPORT_FORMAT)[number];

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

export class NoteTextSectionDto {
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
}

export class NoteMediaSectionDto {
  @ApiPropertyOptional({ type: [CreateNoteMediaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateNoteMediaDto)
  @Validate(UniqueMediaSortOrderConstraint)
  items?: CreateNoteMediaDto[];
}

export class NoteLocationSectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  longitude?: number;
}

export class NoteSectionsDto {
  @ApiPropertyOptional({ type: NoteTextSectionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoteTextSectionDto)
  text?: NoteTextSectionDto;

  @ApiPropertyOptional({ type: NoteMediaSectionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoteMediaSectionDto)
  media?: NoteMediaSectionDto;

  @ApiPropertyOptional({ type: NoteMediaSectionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoteMediaSectionDto)
  showcase?: NoteMediaSectionDto;

  @ApiPropertyOptional({ type: NoteLocationSectionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoteLocationSectionDto)
  location?: NoteLocationSectionDto | null;
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

  @ApiPropertyOptional({ type: NoteSectionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoteSectionsDto)
  sections?: NoteSectionsDto;
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

export class SetNoteStatusDto {
  @ApiProperty({ enum: NOTE_WRITABLE_STATUS })
  @IsEnum(NOTE_WRITABLE_STATUS)
  status: NoteWritableStatus;
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

  @ApiPropertyOptional({
    description: 'Link auto-expires this many days after creation (1-365).',
    minimum: 1,
    maximum: 365,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
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

export class NoteSectionsResponseDto {
  @ApiProperty() text: {
    content: string | null;
    contentJson: unknown[] | null;
  };
  @ApiProperty() media: { items: unknown[] };
  @ApiProperty() showcase: { items: unknown[] };
  @ApiPropertyOptional({ nullable: true }) location: {
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
  } | null;
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
  @ApiProperty() hasText: boolean;
  @ApiProperty() showcaseCount: number;
  @ApiProperty() hasLocation: boolean;
  @ApiPropertyOptional({
    nullable: true,
    description: '聊天收藏来源快照；自建笔记为 null',
  })
  collectedFrom: Record<string, unknown> | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class NoteDetailDto extends NoteSummaryDto {
  @ApiPropertyOptional() content: string | null;
  @ApiPropertyOptional({ type: [Object] }) contentJson?:
    | Record<string, unknown>[]
    | null;
  @ApiProperty({ type: [NoteMediaDto] }) media: NoteMediaDto[];
  @ApiProperty({ type: NoteSectionsResponseDto })
  sections: NoteSectionsResponseDto;
}

/**
 * 访客侧解析 `/s/{token}` 的返回体。
 *
 * 只包含链接快照范围内、当前仍然可见的笔记摘要；`notes` 复用 NoteSummaryDto，
 * 由 mapSummary 负责把 canEdit 置 false 并抹掉 collectedFrom（笔记主人私有）。
 * 必须声明在 NoteSummaryDto 之后：装饰器在类定义时求值，提前引用会命中 TDZ。
 */
export class SharedNoteListDto {
  @ApiProperty() title: string;
  @ApiProperty({ type: [NoteSummaryDto] }) notes: NoteSummaryDto[];
  @ApiPropertyOptional() expiresAt: Date | null;
}

// ── 收藏聊天中的笔记 → 复制入"我的笔记" ────────────────────────────────────────

export const NOTE_COLLECT_CONVERSATION_TYPE = ['private', 'group'] as const;
export type NoteCollectConversationType =
  (typeof NOTE_COLLECT_CONVERSATION_TYPE)[number];

/** 来源名片主体：群或用户（id 兼容 UUID 与 OpenIM 群号，不强校验 UUID） */
export class NoteCollectPeerDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  faceURL?: string;
}

export class NoteCollectSourceDto {
  @ApiProperty({ enum: NOTE_COLLECT_CONVERSATION_TYPE })
  @IsEnum(NOTE_COLLECT_CONVERSATION_TYPE)
  conversationType: NoteCollectConversationType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  conversationID: string;

  /** 分享该笔记的那条消息的 clientMsgID，用于跳回聊天并定位 */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  clientMsgID: string;

  @ApiProperty({ type: NoteCollectPeerDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => NoteCollectPeerDto)
  sender: NoteCollectPeerDto;

  /** 群聊必填（展示群名片）；私聊省略 */
  @ApiPropertyOptional({ type: NoteCollectPeerDto })
  @ValidateIf((source) => source.conversationType === 'group')
  @IsDefined({ message: 'group is required for group conversations' })
  @ValidateNested()
  @Type(() => NoteCollectPeerDto)
  group?: NoteCollectPeerDto;
}

export class CollectNoteDto {
  @ApiProperty()
  @IsUUID()
  noteId: string;

  @ApiProperty({ type: NoteCollectSourceDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => NoteCollectSourceDto)
  source: NoteCollectSourceDto;
}

export class CollectNoteResultDto {
  @ApiProperty({ type: NoteDetailDto }) note: NoteDetailDto;
  /** true = 笔记本来就是自己的，或此前已收藏过（幂等，不产生新副本） */
  @ApiProperty() alreadyCollected: boolean;
}

export class CreateNoteExportDto {
  @ApiProperty({ enum: NOTE_EXPORT_FORMAT })
  @IsEnum(NOTE_EXPORT_FORMAT)
  format: NoteExportFormat;

  @ApiPropertyOptional({
    description: '`ALL` for all media in the requested format, or a media id.',
  })
  @IsOptional()
  @IsString()
  scope?: 'ALL' | string;
}

export class NoteExportResultDto {
  @ApiProperty() url: string;
  @ApiProperty() filename: string;
  @ApiProperty() mimeType: string;
  @ApiPropertyOptional() size: number | null;
  @ApiPropertyOptional() expiresAt: Date | null;
}
