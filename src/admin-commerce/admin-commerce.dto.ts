import { Type, Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  IsIn,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';

export class CommerceQueryDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  search?: string;
}
export class MembershipQueryDto extends CommerceQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(4) level?: number;
  @IsOptional() @IsIn(['active', 'expired', 'lifetime']) expiry?: string;
}
export class OwnershipQueryDto extends CommerceQueryDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids?: string[];
}
