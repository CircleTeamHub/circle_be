import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ConsoleQuery {
  @IsOptional() @IsUUID() taskID?: string;
  @IsOptional() @IsUUID() deviceID?: string;
  @IsOptional() @IsUUID() userID?: string;
  @IsOptional() @IsString() @MaxLength(100) cursor?: string;
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'TERMINAL'])
  status?: string;
  @IsOptional() @IsString() @MaxLength(64) kind?: string;
  @IsOptional() @IsString() @MaxLength(64) name?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days = 30;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
}
export class ReasonDto {
  @IsString() @Length(3, 500) reason!: string;
}
export class RetryDto extends ReasonDto {
  @IsString() @Length(1, 100) version!: string;
}
export class PushSendDto extends ReasonDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  recipients!: string[];
  @IsUUID() announcementID!: string;
}
export class PushSettingsDto extends ReasonDto {
  @IsBoolean() enabled!: boolean;
  @IsInt() @Min(1) version!: number;
}
export const KEY_SCOPES = [
  'tasks',
  'push',
  'timeline',
  'analytics',
  'diagnostics',
] as const;
export class CreateKeyDto extends ReasonDto {
  @IsString() @Length(2, 80) name!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsIn(KEY_SCOPES, { each: true })
  scopes!: string[];
  @IsInt() @Min(1) @Max(30) days!: number;
}
export class ReleaseDto extends ReasonDto {
  @IsIn(['android', 'ios']) platform!: string;
  @IsIn(['stable', 'beta']) channel!: string;
  @Matches(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/) version!: string;
  @IsInt() @Min(1) @Max(2147483647) build!: number;
  @IsString() @MaxLength(1000) url!: string;
  @Matches(/^[a-f0-9]{64}$/i) sha256!: string;
  @IsInt() @Min(1) @Max(2147483647) sizeBytes!: number;
  @IsString() @MaxLength(3000) notes!: string;
}
export class ReleasePlanDto extends ReasonDto {
  @IsUUID() releaseID!: string;
  @IsInt() @Min(0) @Max(100) rollout!: number;
  @IsInt() @Min(0) @Max(2147483647) minBuild!: number;
  @IsInt() @Min(0) @Max(2147483647) maxBuild!: number;
  @IsInt() @Min(0) @Max(2147483647) forceBelow!: number;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsInt() @Min(1) version?: number;
}
export class AppOpenDto {
  @IsIn(['android', 'ios', 'web']) platform!: string;
  @IsString() @Length(1, 32) appVersion!: string;
  @IsInt() @Min(0) @Max(2147483647) build!: number;
  @IsIn(['stable', 'beta']) channel!: string;
  @IsUUID() eventID!: string;
}
export class UpdateDecisionQuery {
  @IsIn(['android', 'ios']) platform!: string;
  @IsIn(['stable', 'beta']) channel!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483647) build!: number;
  @IsString() @Length(16, 128) installation!: string;
}
export class DiagnosticQuery extends ConsoleQuery {
  @IsOptional() @IsUUID() requestID?: string;
}

export class AdminUpdatePreviewQuery extends UpdateDecisionQuery {
  @IsOptional() @IsUUID() installationID?: string;
}
