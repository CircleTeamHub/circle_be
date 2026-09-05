import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ClearHistoryDto {
  /** DIRECT 任一成员可用;GROUP 仅群主/管理员可用;TEMP/SUPPORT 仍仅个人。 */
  @IsOptional()
  @IsBoolean()
  forEveryone?: boolean;

  /** 客户端确认时看到的最高消息水位；重试复用同一值，避免误清新消息。 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  targetHeight?: number;
}
