import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReferralStatus } from 'src/generated/prisma';
import { AdminPageQuery } from 'src/admin-access/admin-access.dto';

export class AuditQuery extends AdminPageQuery {
  @IsOptional() @IsString() @MaxLength(64) actorID?: string;
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsString() @MaxLength(64) entityType?: string;
  @IsOptional() @IsString() @MaxLength(64) entityID?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class ReferralQuery extends AdminPageQuery {
  @IsOptional() @IsEnum(ReferralStatus) status?: ReferralStatus;
  @IsOptional() @IsUUID() campaignID?: string;
}

export class CreateCampaignDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 80)
  name: string;
  @IsString() @Length(4, 32) ownerAccountId: string;
  @IsInt() @Min(1) @Max(50) count: number;
  @IsInt() @Min(1) @Max(100000) maxUses: number;
  @IsDateString() expiresAt: string;
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}

export class UpdateCampaignDto {
  @IsInt() @Min(1) version: number;
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(1) @Max(100000) maxUses: number;
  @IsDateString() expiresAt: string;
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}

export class AdvertisementDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 80)
  title: string;
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl: string;
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  targetUrl: string;
  @IsIn(['CIRCLE_HOME']) placement: string;
  @IsInt() @Min(0) @Max(10000) sortOrder: number;
  @IsBoolean() enabled: boolean;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}

export class UpdateAdvertisementDto extends AdvertisementDto {
  @IsInt() @Min(1) version: number;
}

export class PublishedAdvertisementQuery {
  @IsIn(['CIRCLE_HOME']) placement: string;
}
