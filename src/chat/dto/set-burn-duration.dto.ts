import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * 会话级阅后即焚档位(S-01)。白名单而不是任意秒数:与客户端选项一致,
 * 也防止 1 秒之类的恶作剧值把对方的历史即时烧光。0/null = 关闭。
 */
export const BURN_DURATION_CHOICES = [
  0,
  30,
  5 * 60,
  60 * 60,
  24 * 60 * 60,
  7 * 24 * 60 * 60,
] as const;

export class SetBurnDurationDto {
  @ApiPropertyOptional({
    description: `焚毁秒数,白名单 ${BURN_DURATION_CHOICES.join('/')};0 或缺省 = 关闭`,
  })
  @IsOptional()
  @IsIn(BURN_DURATION_CHOICES as readonly number[])
  seconds?: number | null;
}
