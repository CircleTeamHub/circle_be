import { Type, Transform } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ImListDto {
  @IsOptional() @IsString() @MaxLength(128) keyword?: string;
  @IsOptional() @IsIn(['DIRECT', 'GROUP']) type?: 'DIRECT' | 'GROUP';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class ImMessageQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) cursor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
  @IsOptional() @IsUUID() senderId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) text?: string;
}
export class ImMemberActionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason: string;
  @Equals(true) confirmed: boolean;
  @IsIn(['mute', 'unmute', 'remove', 'role']) action:
    | 'mute'
    | 'unmute'
    | 'remove'
    | 'role';
  @IsOptional() @IsIn(['ADMIN', 'MEMBER']) role?: 'ADMIN' | 'MEMBER';
}
