import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MembershipBenefitType } from 'src/generated/prisma';
import {
  MembershipBadge,
  MembershipNameColor,
  MembershipQuotaDisplay,
  MembershipTierKey,
} from '../membership.catalog';

export class MembershipQuotaValueDto {
  @ApiProperty() actual: number;
  @ApiProperty() display: MembershipQuotaDisplay;
}

export class MembershipQuotasDto {
  @ApiProperty({ type: MembershipQuotaValueDto })
  groupMembers: MembershipQuotaValueDto;
  @ApiProperty({ type: MembershipQuotaValueDto })
  joinedCircles: MembershipQuotaValueDto;
  @ApiProperty({ type: MembershipQuotaValueDto })
  createdCircles: MembershipQuotaValueDto;
  @ApiProperty({ type: MembershipQuotaValueDto })
  notes: MembershipQuotaValueDto;
  @ApiProperty({ type: MembershipQuotaValueDto })
  cityFilters: MembershipQuotaValueDto;
}

export class MembershipAppearanceDto {
  @ApiProperty() nameColor: MembershipNameColor;
  @ApiProperty({ nullable: true }) badge: MembershipBadge | null;
}

export class MembershipBenefitsDto {
  @ApiProperty() premiumCircle: boolean;
  @ApiProperty({ enum: ['standard', 'premium'], nullable: true })
  fancyNumberVoucher: 'standard' | 'premium' | null;
}

export class MembershipPlanDto {
  @ApiProperty({ minimum: 1, maximum: 4 }) level: number;
  @ApiProperty({ enum: ['silver', 'gold', 'diamond', 'super'] })
  key: Exclude<MembershipTierKey, 'regular'>;
  @ApiProperty({ nullable: true }) durationMonths: number | null;
  @ApiProperty() lifetime: boolean;
  @ApiProperty() priceCny: number;
  @ApiProperty() recommended: boolean;
  @ApiProperty({ type: MembershipQuotasDto }) quotas: MembershipQuotasDto;
  @ApiProperty({ type: MembershipAppearanceDto })
  appearance: MembershipAppearanceDto;
  @ApiProperty({ type: MembershipBenefitsDto }) benefits: MembershipBenefitsDto;
}

export class MembershipBenefitGrantStatusDto {
  @ApiProperty() available: boolean;
  @ApiProperty() issued: boolean;
}

export class MembershipBenefitGrantsDto {
  @ApiProperty({ type: MembershipBenefitGrantStatusDto })
  standardFancyNumber: MembershipBenefitGrantStatusDto;
  @ApiProperty({ type: MembershipBenefitGrantStatusDto })
  premiumFancyNumber: MembershipBenefitGrantStatusDto;
}

export class MembershipStatusDto {
  @ApiProperty() storedLevel: number;
  @ApiProperty() effectiveLevel: number;
  @ApiProperty({ enum: ['regular', 'silver', 'gold', 'diamond', 'super'] })
  key: MembershipTierKey;
  @ApiProperty({ nullable: true }) vipExpiresAt: Date | null;
  @ApiProperty() lifetime: boolean;
  @ApiProperty() active: boolean;
  @ApiProperty({ type: MembershipQuotasDto }) quotas: MembershipQuotasDto;
  @ApiProperty({ type: MembershipAppearanceDto })
  appearance: MembershipAppearanceDto;
  @ApiProperty({ type: MembershipBenefitsDto }) benefits: MembershipBenefitsDto;
  @ApiProperty({ type: MembershipBenefitGrantsDto })
  benefitGrants: MembershipBenefitGrantsDto;
}

export class CreateMembershipGrantDto {
  @ApiProperty({ minimum: 1, maximum: 4 })
  @IsInt()
  @Min(1)
  @Max(4)
  targetLevel: number;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  idempotencyKey: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class MembershipGrantAuditDto {
  @ApiProperty() id: string;
  @ApiProperty({ format: 'uuid' }) idempotencyKey: string;
  @ApiProperty({ format: 'uuid' }) targetUserId: string;
  @ApiProperty({ format: 'uuid' }) operatorUserId: string;
  @ApiProperty() previousLevel: number;
  @ApiProperty() previousEffectiveLevel: number;
  @ApiProperty() newLevel: number;
  @ApiProperty({ nullable: true }) previousExpiresAt: Date | null;
  @ApiProperty({ nullable: true }) newExpiresAt: Date | null;
  @ApiProperty({ nullable: true }) note: string | null;
  @ApiProperty() createdAt: Date;
}

export class MembershipAdminGrantResponseDto {
  @ApiProperty() replayed: boolean;
  @ApiProperty({ type: MembershipGrantAuditDto })
  grant: MembershipGrantAuditDto;
  @ApiProperty({ type: MembershipStatusDto }) membership: MembershipStatusDto;
  @ApiProperty({ enum: MembershipBenefitType, isArray: true })
  issuedBenefitTypes: MembershipBenefitType[];
}
