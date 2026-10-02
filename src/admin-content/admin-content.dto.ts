import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CirclePostStatus } from 'src/generated/prisma';
import { MAX_PAGE } from 'src/common/pagination';

export class ListAdminWordsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class ListAdminPostsDto extends ListAdminWordsDto {
  @IsOptional() @IsEnum(CirclePostStatus) status?: CirclePostStatus;
}
