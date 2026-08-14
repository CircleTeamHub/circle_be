import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ReferralStatus } from 'src/generated/prisma';
import {
  REFERRAL_LIST_DEFAULT_LIMIT,
  REFERRAL_LIST_MAX_LIMIT,
} from '../referral.constants';

export class ReferralListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({
    default: REFERRAL_LIST_DEFAULT_LIMIT,
    minimum: 1,
    maximum: REFERRAL_LIST_MAX_LIMIT,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(REFERRAL_LIST_MAX_LIMIT)
  limit: number = REFERRAL_LIST_DEFAULT_LIMIT;
}

export class ReferralRulesDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty() inviterReward: number;
  @ApiProperty() inviteeReward: number;
  @ApiProperty() qualificationDays: number;
  @ApiProperty() expiryDays: number;
  @ApiProperty() monthlyCap: number;
}

export class ReferralSummaryDto {
  @ApiProperty() total: number;
  @ApiProperty() pending: number;
  @ApiProperty() rewarded: number;
  @ApiProperty() capped: number;
  @ApiProperty() rejected: number;
  @ApiProperty() expired: number;
  @ApiProperty() pointsEarned: number;
}

export class ReferralInviteeDto {
  @ApiProperty() id: string;
  @ApiProperty() nickname: string;
}

export class ReferralItemDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ReferralStatus }) status: ReferralStatus;
  @ApiProperty() inviterReward: number;
  @ApiProperty() inviteeReward: number;
  @ApiProperty() eligibleAt: Date;
  @ApiProperty() expiresAt: Date;
  @ApiPropertyOptional() qualifiedAt: Date | null;
  @ApiPropertyOptional() rewardedAt: Date | null;
  @ApiPropertyOptional() failureReason: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: ReferralInviteeDto }) invitee: ReferralInviteeDto;
}

export class MyReferralsDto {
  @ApiProperty() inviteCode: string;
  @ApiProperty({ type: ReferralRulesDto }) rules: ReferralRulesDto;
  @ApiProperty({ type: ReferralSummaryDto }) summary: ReferralSummaryDto;
  @ApiProperty({ type: [ReferralItemDto] }) items: ReferralItemDto[];
  @ApiPropertyOptional({ format: 'uuid' }) nextCursor: string | null;
}
