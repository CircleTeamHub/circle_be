import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 两个字段都读转换前的原值。全局 ValidationPipe 开着 enableImplicitConversion：
 * 它把任意非空字符串转成 true，把 false→0、true→1。此处的后果很具体 ——
 * `targetHeight: false` 会被转成 0，通过 @IsInt/@Min(0)，然后落进服务端的
 * `clearThrough <= 0` 分支：一条都不清，却返回 200 和 clearedBeforeHeight: 0，
 * 用户看到的是「已清空」。做法与 circle.dto.ts / support.dto.ts 一致。
 */
export class ClearHistoryDto {
  /** DIRECT 任一成员可用;GROUP 仅群主/管理员可用;TEMP/SUPPORT 仍仅个人。 */
  @IsOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.forEveryone)
  @IsBoolean()
  forEveryone?: boolean;

  /** 客户端确认时看到的最高消息水位；重试复用同一值，避免误清新消息。 */
  @IsOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.targetHeight)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  targetHeight?: number;
}
