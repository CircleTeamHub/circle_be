import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional } from 'class-validator';

export const SELF_DESTRUCT_DAY_OPTIONS = [0, 1, 2, 7, 30] as const;
export const MOMENTS_VISIBILITY_OPTIONS = [
  'ALL',
  'FRIENDS_ONLY',
  'PRIVATE',
] as const;
export const PERMISSION_OPTIONS = ['EVERYONE', 'FRIENDS_ONLY', 'NONE'] as const;

export type SelfDestructDays = (typeof SELF_DESTRUCT_DAY_OPTIONS)[number];
export type MomentsVisibility = (typeof MOMENTS_VISIBILITY_OPTIONS)[number];
export type PrivacyPermission = (typeof PERMISSION_OPTIONS)[number];

export class PrivacySettingsDto {
  messageSelfDestructDays: SelfDestructDays;
  momentsVisibility: MomentsVisibility;
  allowStrangerMessages: boolean;
  showPhone: boolean;
  showWechat: boolean;
  showQQ: boolean;
  showWhatsup: boolean;
  addMeByAccount: boolean;
  addMeByPhone: boolean;
  addMeByQrCode: boolean;
  addMeByGroup: boolean;
  callPermission: PrivacyPermission;
  groupInvitePermission: PrivacyPermission;
}

export class UpdatePrivacySettingsDto {
  @ApiPropertyOptional({ enum: SELF_DESTRUCT_DAY_OPTIONS })
  @IsOptional()
  @IsInt()
  @IsIn(SELF_DESTRUCT_DAY_OPTIONS)
  messageSelfDestructDays?: SelfDestructDays;

  @ApiPropertyOptional({ enum: MOMENTS_VISIBILITY_OPTIONS })
  @IsOptional()
  @IsIn(MOMENTS_VISIBILITY_OPTIONS)
  momentsVisibility?: MomentsVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowStrangerMessages?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showWechat?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showQQ?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showWhatsup?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  addMeByAccount?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  addMeByPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  addMeByQrCode?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  addMeByGroup?: boolean;

  @ApiPropertyOptional({ enum: PERMISSION_OPTIONS })
  @IsOptional()
  @IsIn(PERMISSION_OPTIONS)
  callPermission?: PrivacyPermission;

  @ApiPropertyOptional({ enum: PERMISSION_OPTIONS })
  @IsOptional()
  @IsIn(PERMISSION_OPTIONS)
  groupInvitePermission?: PrivacyPermission;
}
