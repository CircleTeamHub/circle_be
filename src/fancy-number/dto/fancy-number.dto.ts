import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FancyNumberStatus } from 'src/generated/prisma';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';
import {
  CUSTOM_FANCY_NUMBER_PATTERN,
  CUSTOM_FANCY_NUMBER_RULE_MESSAGE,
} from '../fancy-number.rules';

function normalizeCustomValue(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class PurchaseFancyNumberDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    description: 'Required for non-super members; ignored for super members.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  months?: number;
}

export class RenewFancyNumberDto {
  @ApiProperty({ minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  months: number;
}

export class CheckCustomFancyNumberQueryDto {
  @ApiProperty({
    minLength: 6,
    maxLength: 6,
    pattern: CUSTOM_FANCY_NUMBER_PATTERN.source,
  })
  @Transform(({ value }: { value: unknown }) => normalizeCustomValue(value))
  @IsString()
  @Matches(CUSTOM_FANCY_NUMBER_PATTERN, {
    message: CUSTOM_FANCY_NUMBER_RULE_MESSAGE,
  })
  value: string;
}

export class PurchaseCustomFancyNumberDto extends PurchaseFancyNumberDto {
  @ApiProperty({
    minLength: 6,
    maxLength: 6,
    pattern: CUSTOM_FANCY_NUMBER_PATTERN.source,
  })
  @Transform(({ value }: { value: unknown }) => normalizeCustomValue(value))
  @IsString()
  @Matches(CUSTOM_FANCY_NUMBER_PATTERN, {
    message: CUSTOM_FANCY_NUMBER_RULE_MESSAGE,
  })
  value: string;
}

export class SwitchCustomFancyNumberDto extends CheckCustomFancyNumberQueryDto {}

export class BatchCreateFancyNumbersDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 100 })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item) =>
          typeof item === 'string' ? item.trim().toLowerCase() : item,
        )
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(ACCOUNT_ID_PATTERN, {
    each: true,
    message: ACCOUNT_ID_RULE_MESSAGE,
  })
  values: string[];
}

export class ListFancyNumbersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class AdminListFancyNumbersQueryDto extends ListFancyNumbersQueryDto {
  @ApiPropertyOptional({ enum: FancyNumberStatus })
  @IsOptional()
  @IsEnum(FancyNumberStatus)
  status?: FancyNumberStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  search?: string;
}

export class SetFancyNumberAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}

export class AddFancyNumberRecommendationsDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 100 })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item) =>
          typeof item === 'string' ? item.trim().toUpperCase() : item,
        )
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(CUSTOM_FANCY_NUMBER_PATTERN, {
    each: true,
    message: CUSTOM_FANCY_NUMBER_RULE_MESSAGE,
  })
  values: string[];
}

export class SetFancyNumberRecommendationDto {
  @ApiProperty()
  @IsBoolean()
  recommended: boolean;
}

export class ReorderFancyNumberRecommendationsDto {
  @ApiProperty({ type: [String], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  expectedIds: string[];

  @ApiProperty({ type: [String], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids: string[];
}

export class FancyNumberItemDto {
  @ApiProperty() id: string;
  @ApiProperty() value: string;
}

export class FancyNumberListDto {
  @ApiProperty({ type: [FancyNumberItemDto] })
  items: FancyNumberItemDto[];
  @ApiProperty({ nullable: true }) nextCursor: string | null;
  @ApiProperty() unitPrice: number;
  @ApiProperty() minMonths: number;
  @ApiProperty() maxMonths: number;
  @ApiProperty({ enum: ['PAID_MONTHLY', 'PERMANENT_FREE'] })
  purchaseMode: 'PAID_MONTHLY' | 'PERMANENT_FREE';
}

export class MyFancyNumberDto {
  @ApiProperty() active: boolean;
  @ApiProperty({ nullable: true }) accountId: string | null;
  @ApiProperty({ nullable: true }) restoreAccountId: string | null;
  @ApiProperty({ nullable: true }) startedAt: Date | null;
  @ApiProperty({ nullable: true }) expiresAt: Date | null;
  @ApiProperty() permanent: boolean;
  @ApiProperty() renewable: boolean;
  @ApiProperty() unitPrice: number;
}

export class FancyNumberPurchaseResultDto {
  @ApiProperty() orderId: string;
  @ApiProperty() accountId: string;
  @ApiProperty({ nullable: true }) expiresAt: Date | null;
  @ApiProperty() permanent: boolean;
  @ApiProperty({ nullable: true }) months: number | null;
  @ApiProperty() unitPrice: number;
  @ApiProperty() totalPrice: number;
  @ApiProperty() walletBalanceAfter: number;
}

export class CustomFancyNumberAvailabilityDto {
  @ApiProperty() value: string;
  @ApiProperty() available: boolean;
  @ApiProperty({ enum: ['TAKEN', 'RESERVED'], nullable: true })
  reason: 'TAKEN' | 'RESERVED' | null;
}
