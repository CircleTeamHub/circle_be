import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  BURN_DURATION_CHOICES,
  type BurnDurationSec,
} from '../common/burn-durations';

/**
 * 自动回复文案上限，按**码点**计。
 *
 * 三层此前口径不一致：DTO 用 @MaxLength(200) 数的是 UTF-16 码元，而 service 用
 * Array.from(...).length、数据库列是 VARCHAR(200)，这两处数的是码点。于是 120 个
 * emoji（240 码元、120 码点）会被 DTO 挡在门外，尽管另外两层都认为它合法 ——
 * 而 service 那条 spec 直接调 service、绕过了 DTO，所以 CI 里看不见这个分歧。
 */
export const AUTO_REPLY_TEXT_MAX_CODE_POINTS = 200;

@ValidatorConstraint({ name: 'autoReplyTextLength', async: false })
class AutoReplyTextLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    // 非字符串交给 @IsString 报，这里只管长度。
    if (typeof value !== 'string') return true;
    return Array.from(value).length <= AUTO_REPLY_TEXT_MAX_CODE_POINTS;
  }

  defaultMessage() {
    return `directMessageAutoReplyText must be at most ${AUTO_REPLY_TEXT_MAX_CODE_POINTS} characters`;
  }
}

/**
 * 全局阅后即焚档位。以前这里是**天数**白名单 [0,1,2,7,30],而会话级焚毁用的是
 * 另一张秒数表 —— 同一个功能在两个入口给用户看两张不同的档位表(「10 分钟」
 * 只有单会话有,「30 天」只有全局有)。现在两处都读 BURN_DURATION_CHOICES。
 */
export { BURN_DURATION_CHOICES, type BurnDurationSec };

export const MOMENTS_VISIBILITY_OPTIONS = [
  'ALL',
  'FRIENDS_ONLY',
  'PRIVATE',
] as const;
export const PERMISSION_OPTIONS = ['EVERYONE', 'FRIENDS_ONLY', 'NONE'] as const;

export type MomentsVisibility = (typeof MOMENTS_VISIBILITY_OPTIONS)[number];
export type PrivacyPermission = (typeof PERMISSION_OPTIONS)[number];

export class PrivacySettingsDto {
  messageSelfDestructSec: BurnDurationSec;
  momentsVisibility: MomentsVisibility;
  allowStrangerMessages: boolean;
  showPhone: boolean;
  showEmail: boolean;
  showWechat: boolean;
  showQQ: boolean;
  showWhatsup: boolean;
  addMeByAccount: boolean;
  addMeByPhone: boolean;
  addMeByQrCode: boolean;
  addMeByGroup: boolean;
  callPermission: PrivacyPermission;
  groupInvitePermission: PrivacyPermission;
  directMessageAutoReplyEnabled: boolean;
  directMessageAutoReplyText: string;
}

export class UpdatePrivacySettingsDto {
  @ApiPropertyOptional({ enum: BURN_DURATION_CHOICES })
  @IsOptional()
  @IsInt()
  @IsIn(BURN_DURATION_CHOICES as readonly number[])
  messageSelfDestructSec?: BurnDurationSec;

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
  showEmail?: boolean;

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

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) =>
      obj.directMessageAutoReplyEnabled,
  )
  @IsBoolean()
  directMessageAutoReplyEnabled?: boolean;

  @ApiPropertyOptional({ default: '', maxLength: 200 })
  @IsOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    const value = obj.directMessageAutoReplyText;
    return typeof value === 'string' ? value.trim() : value;
  })
  @IsString()
  @Validate(AutoReplyTextLengthConstraint)
  directMessageAutoReplyText?: string;
}
