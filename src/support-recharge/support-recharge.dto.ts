import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  SupportRechargeFulfillmentType,
  SupportRechargeOrderStatus,
} from 'src/generated/prisma';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateSupportRechargePaymentCodeDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label: string;

  @ApiProperty({ description: 'POST /upload/presign 返回的 chat/ object key' })
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  @Matches(
    /^chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9-]+\.[a-z0-9]{1,12}$/i,
  )
  objectKey: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  validFrom: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @ValidateIf(
    (dto: CreateSupportRechargePaymentCodeDto) => dto.validUntil != null,
  )
  @IsISO8601({ strict: true })
  validUntil?: string | null;
}

export class UpdateSupportRechargePaymentCodeDto extends PartialType(
  CreateSupportRechargePaymentCodeDto,
) {}

export class SetSupportRechargePaymentCodeEnabledDto {
  @ApiProperty()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.enabled)
  @IsBoolean()
  enabled: boolean;
}

export class ListSupportRechargeOrdersQueryDto {
  @ApiPropertyOptional({ enum: SupportRechargeOrderStatus })
  @IsOptional()
  @IsEnum(SupportRechargeOrderStatus)
  status?: SupportRechargeOrderStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: '上一页最后一条申请的 id',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class ApproveSupportRechargeOrderDto {
  @ApiProperty({ enum: ['COIN', 'MEMBERSHIP'] })
  @IsIn(['COIN', 'MEMBERSHIP'])
  fulfillmentType: Extract<
    SupportRechargeFulfillmentType,
    'COIN' | 'MEMBERSHIP'
  >;

  @ApiProperty({ minLength: 1, maxLength: 128 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  paymentTransactionId: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1_000_000 })
  @ValidateIf(
    (dto: ApproveSupportRechargeOrderDto) => dto.fulfillmentType === 'COIN',
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  coinAmount?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 4 })
  @ValidateIf(
    (dto: ApproveSupportRechargeOrderDto) =>
      dto.fulfillmentType === 'MEMBERSHIP',
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  membershipLevel?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @Transform(trimmed)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectSupportRechargeOrderDto {
  @ApiProperty({ minLength: 1, maxLength: 300 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason: string;
}
