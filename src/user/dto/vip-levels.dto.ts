import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 批量查询 userId → vipLevel 的入参（前端渲染会员名字特效用）。
 * 一次最多 200 个，避免超大 IN 查询。
 *
 * 用 IsString 而非 IsUUID：这是尽力而为的展示功能，混进一个非 UUID（如聊天里的
 * 异常 sendID）不该让整批 400；不存在 / 非法的 id 在 Prisma 查询里自然查不到即可。
 */
export class VipLevelsDto {
  @ApiProperty({
    description: 'User ids to look up vipLevel for (name-effect rendering)',
    type: [String],
    maxItems: 200,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids: string[];
}
