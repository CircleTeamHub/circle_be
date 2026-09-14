import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  BURN_DURATION_CHOICES,
  type BurnDurationSec,
} from '../common/burn-durations';
import { IsOptionalNotNull } from '../common/validation';

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
  /** 对他人显示在线状态与最近在线时间(在线点 / 「N 分钟前在线」)。 */
  shareOnlineStatus: boolean;
  /** 单聊里向对方上报「正在输入」。 */
  shareTypingInDirect: boolean;
  /** 群聊里向群成员上报「正在输入」。 */
  shareTypingInGroup: boolean;
}

// UserPrivacySetting 的每一列都是非空列：省略 = 不改，显式 null 在校验层回 400，
// 不再穿过 @IsOptional 落到 upsert 成 PrismaClientValidationError（500）。
export class UpdatePrivacySettingsDto {
  @ApiPropertyOptional({ enum: BURN_DURATION_CHOICES })
  @IsOptionalNotNull()
  @IsInt()
  @IsIn(BURN_DURATION_CHOICES as readonly number[])
  messageSelfDestructSec?: BurnDurationSec;

  @ApiPropertyOptional({ enum: MOMENTS_VISIBILITY_OPTIONS })
  @IsOptionalNotNull()
  @IsIn(MOMENTS_VISIBILITY_OPTIONS)
  momentsVisibility?: MomentsVisibility;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  allowStrangerMessages?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  showPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  showEmail?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  showWechat?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  showQQ?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  showWhatsup?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  addMeByAccount?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  addMeByPhone?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  addMeByQrCode?: boolean;

  @ApiPropertyOptional()
  @IsOptionalNotNull()
  @IsBoolean()
  addMeByGroup?: boolean;

  @ApiPropertyOptional({ enum: PERMISSION_OPTIONS })
  @IsOptionalNotNull()
  @IsIn(PERMISSION_OPTIONS)
  callPermission?: PrivacyPermission;

  @ApiPropertyOptional({ enum: PERMISSION_OPTIONS })
  @IsOptionalNotNull()
  @IsIn(PERMISSION_OPTIONS)
  groupInvitePermission?: PrivacyPermission;

  @ApiPropertyOptional({ default: false })
  @IsOptionalNotNull()
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) =>
      obj.directMessageAutoReplyEnabled,
  )
  @IsBoolean()
  directMessageAutoReplyEnabled?: boolean;

  @ApiPropertyOptional({ default: '', maxLength: 200 })
  @IsOptionalNotNull()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    const value = obj.directMessageAutoReplyText;
    return typeof value === 'string' ? value.trim() : value;
  })
  @IsString()
  @Validate(AutoReplyTextLengthConstraint)
  directMessageAutoReplyText?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptionalNotNull()
  @IsBoolean()
  shareOnlineStatus?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptionalNotNull()
  @IsBoolean()
  shareTypingInDirect?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptionalNotNull()
  @IsBoolean()
  shareTypingInGroup?: boolean;
}
